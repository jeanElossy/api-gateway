// File: middlewares/aml.js

const logger = require('../logger');
const {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
} = require('../services/aml');
const blacklist = require('../aml/blacklist.json');
const { sendFraudAlert } = require('../utils/alert');

// === Plafonds AML par provider & symbole monétaire ===
const AML_LIMITS = {
  paynoval: {
    'F CFA': 5_000_000,
    '€': 10_000,
    '$USD': 10_000,
    '$CAD': 10_000,
  },
  stripe: {
    '€': 10_000,
    '$USD': 10_000,
    'F CFA': 3_000_000,
    '$CAD': 10_000,
  },
  mobilemoney: {
    'F CFA': 2_000_000,
    '€': 2_000,
    '$USD': 2_000,
    '$CAD': 2_000,
  },
  bank: {
    '€': 100_000,
    '$USD': 100_000,
    'F CFA': 50_000_000,
    '$CAD': 100_000,
  }
};

const RISKY_COUNTRIES = ['IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF', 'SO', 'YE', 'VE', 'LY'];
const ALLOWED_STRIPE_CURRENCIES = ['€', '$USD'];

// Utilise ton mapping symbole selon le pays (peut être importé)
const getCurrencySymbolByCountry = (country) => {
  const normalized = (country || "")
    .replace(/^[^\w]+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  switch (normalized) {
    case "cote d'ivoire":
    case "burkina faso":
    case "mali":
    case "senegal":
    case "cameroun":
      return "F CFA";
    case "france":
    case "belgique":
    case "allemagne":
      return "€";
    case "usa":
    case "etats-unis":
      return "$USD";
    case "canada":
      return "$CAD";
    default:
      return "F CFA"; // fallback
  }
};

// Masque les champs sensibles pour les logs
function maskSensitive(obj) {
  const SENSITIVE_FIELDS = [
    'password', 'cardNumber', 'iban', 'cvc', 'securityCode', 'otp', 'code'
  ];
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_FIELDS.includes(k)) {
      out[k] = '***';
    } else if (typeof obj[k] === 'object') {
      out[k] = maskSensitive(obj[k]);
    } else {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * Middleware AML principal (symbole monnaie, plafond simple, message UX friendly)
 */
module.exports = async function amlMiddleware(req, res, next) {
  const provider = req.routedProvider || req.body.destination || req.body.provider;
  let { amount, toEmail, iban, phoneNumber, country } = req.body;

  // Détermination du symbole
  const currencySender = req.body.senderCurrencySymbol || req.body.currencySender;
  const currencySymbol = currencySender || req.body.currency || getCurrencySymbolByCountry(country);
  const user = req.user;

  // Vérif amount (number) et conversion sécurisée
  if (typeof amount === "string") {
    amount = parseFloat(amount.replace(/\s/g, '').replace(',', '.'));
  }
  if (isNaN(amount) || !isFinite(amount)) amount = 0;

  try {
    // 1. Auth obligatoire
    if (!user || !user._id) {
      logger.warn('[AML] User manquant', { provider });
      await logTransaction({ userId: null, type: 'initiate', provider: provider || 'inconnu', amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'User manquant' });
      return res.status(401).json({ error: "Authentification requise." });
    }

    // Prépare les infos pour OFAC/SDN
    const recipient = req.body.recipientInfo || {};
    const senderCheck = {
      name: user.fullName,
      iban: user.iban,
      email: user.email,
      phone: user.phone,
      country: user.selectedCountry,
    };
    const recipientCheck = {
      name: recipient.name || recipient.accountHolderName || '',
      iban: recipient.iban || '',
      email: recipient.email || '',
      phone: recipient.phone || '',
      country: recipient.country || recipient.selectedCountry || '',
    };

    // 2. Vérification KYC/KYB
    if (user.type === 'business' || user.isBusiness) {
      let kybStatus = user.kybStatus;
      if (typeof getBusinessKYBStatus === 'function') {
        kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
      }
      if (!kybStatus || kybStatus !== 'validé') {
        logger.warn('[AML] KYB insuffisant', { provider, user: user.email });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'KYB insuffisant' });
        await sendFraudAlert({ user, type: 'kyb_insuffisant', provider });
        return res.status(403).json({ error: "KYB incomplet, transaction refusée." });
      }
    } else {
      if (!user.kycLevel || user.kycLevel < 2) {
        logger.warn('[AML] KYC insuffisant', { provider, user: user.email });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'KYC insuffisant' });
        await sendFraudAlert({ user, type: 'kyc_insuffisant', provider });
        return res.status(403).json({ error: "KYC incomplet, transaction refusée." });
      }
    }

    // 3. PEP/sanction interne
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error('[AML] PEP/Sanction detected', { user: user.email, reason: pepStatus.reason });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: pepStatus.reason });
      await sendFraudAlert({ user, type: 'pep_sanction', provider, reason: pepStatus.reason });
      return res.status(403).json({ error: "Transaction vers personne sanctionnée interdite." });
    }

    // 4. Blacklist (emails, IBAN, phones)
    if ((toEmail && blacklist.emails.includes(toEmail)) ||
        (iban && blacklist.ibans.includes(iban)) ||
        (phoneNumber && blacklist.phones.includes(phoneNumber))) {
      logger.warn('[AML] Transaction vers cible blacklistée', { provider, toEmail, iban, phoneNumber });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Blacklist' });
      await sendFraudAlert({ user, type: 'blacklist', provider, toEmail, iban, phoneNumber });
      return res.status(403).json({ error: "Destinataire interdit (blacklist AML)." });
    }

    // 5. Pays à risque/sanctionné
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Pays à risque' });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // 6. Plafond AML par transaction (sur le symbole)
    const providerLimits = AML_LIMITS[provider] || {};
    let limit = providerLimits[currencySymbol];
    if (!limit) {
      logger.warn(`[AML] Limite non définie pour provider=${provider} currencySymbol=${currencySymbol}, fallback sur 10_000`);
      limit = 10_000; // Fallback si non renseigné
    }

    // 7. Challenge AML (question sécurité) si montant proche du plafond
    const userQuestions = user.securityQuestions || [];
    const needAmlChallenge = typeof amount === 'number' && amount >= limit * 0.9 && userQuestions.length > 0;
    if (needAmlChallenge) {
      if (!req.body.securityQuestion || !req.body.securityAnswer) {
        const qIdx = Math.floor(Math.random() * userQuestions.length);
        return res.status(428).json({
          error: 'AML_SECURITY_CHALLENGE',
          need_security_answer: true,
          security_question: userQuestions[qIdx].question,
        });
      } else {
        const idx = userQuestions.findIndex(q => q.question === req.body.securityQuestion);
        if (idx === -1) {
          return res.status(403).json({ error: 'Question AML inconnue.' });
        }
        if (
          userQuestions[idx].answer.trim().toLowerCase() !==
          req.body.securityAnswer.trim().toLowerCase()
        ) {
          logger.warn('[AML] Réponse AML incorrecte', { user: user.email });
          await logTransaction({
            userId: user._id, type: 'initiate', provider, amount, toEmail,
            details: maskSensitive(req.body), flagged: true, flagReason: 'AML Sécurité question échouée'
          });
          await sendFraudAlert({ user, type: 'aml_security_failed', provider });
          return res.status(403).json({ error: "Réponse à la question de sécurité incorrecte." });
        }
      }
    }

    // 8. Plafond journalier (pas de *3)
    const stats = await getUserTransactionsStats(user._id, provider);
    const dailyCap = limit; // un seul plafond journalier
    const futureTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + (amount || 0);

    if (futureTotal > dailyCap) {
      logger.warn('[AML] Plafond journalier dépassé', {
        provider, user: user.email, dailyTotal: stats.dailyTotal, tryAmount: amount, max: dailyCap, currencySymbol
      });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true,
        flagReason: `Plafond journalier dépassé (${stats.dailyTotal} + ${amount} > ${dailyCap} ${currencySymbol})`
      });
      // MESSAGE TRÈS CLAIR POUR L'UTILISATEUR :
      return res.status(403).json({
        error: `Le plafond journalier autorisé est atteint pour la devise ${currencySymbol}. Vous ne pouvez plus effectuer de nouvelles transactions aujourd'hui avec ce moyen de paiement. Réessayez demain ou changez de mode de paiement.`,
        details: { max: dailyCap, currency: currencySymbol, provider }
      });
    }

    if (stats && stats.lastHour > 10) {
      logger.warn('[AML] Volume suspect sur 1h', { provider, user: user.email, lastHour: stats.lastHour });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Volume élevé 1h' });
      await sendFraudAlert({ user, type: 'volume_1h', provider, count: stats.lastHour });
      return res.status(403).json({ error: "Trop de transactions sur 1h, vérification requise." });
    }

    if (stats && stats.sameDestShortTime > 3) {
      logger.warn('[AML] Pattern structuring suspect', { provider, user: user.email, sameDestShortTime: stats.sameDestShortTime });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Pattern structuring' });
      await sendFraudAlert({ user, type: 'structuring', provider, count: stats.sameDestShortTime });
      return res.status(403).json({ error: "Pattern transactionnel suspect, vérification requise." });
    }

    // 9. Stripe : devise autorisée (symbole)
    if (provider === 'stripe' && currencySymbol && !ALLOWED_STRIPE_CURRENCIES.includes(currencySymbol)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currencySymbol });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Devise interdite Stripe' });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currencySymbol });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // 10. ML scoring (optionnel)
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user);
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Scoring ML élevé' });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({ error: "Transaction suspecte (analyse IA), contrôle manuel." });
      }
    }

    // 11. Log OK
    await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: false, flagReason: '' });
    logger.info('[AML] AML OK', { provider, user: user.email, amount, toEmail, iban, phoneNumber, country, stats });

    // ✅ Transaction validée !
    next();
  } catch (e) {
    logger.error('[AML] Exception', { err: e, user: user?.email });
    await logTransaction({ userId: user?._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Erreur système AML' });
    return res.status(500).json({ error: "Erreur système AML" });
  }
};
