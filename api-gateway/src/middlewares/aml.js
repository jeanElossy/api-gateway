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
// const { isSanctioned } = require('../tools/ofacCheck'); // <-- Optionnel, à activer si OFAC check

// === Plafonds AML par provider & devise (utilise la devise de l’expéditeur !) ===
const AML_LIMITS = {
  paynoval: {
    XOF: 5_000_000,
    XAF: 5_000_000,
    EUR: 10_000,
    USD: 10_000,
    CAD: 10_000,
  },
  stripe: {
    EUR: 10_000,
    USD: 10_000,
    XOF: 3_000_000,
    XAF: 3_000_000,
    CAD: 10_000,
  },
  mobilemoney: {
    XOF: 2_000_000,
    XAF: 2_000_000,
    EUR: 2_000,
    USD: 2_000,
    CAD: 2_000,
  },
  bank: {
    EUR: 100_000,
    USD: 100_000,
    XOF: 50_000_000,
    XAF: 50_000_000,
    CAD: 100_000,
  }
};

// === Liste des pays à risque AML ===
const RISKY_COUNTRIES = ['IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF', 'SO', 'YE', 'VE', 'LY'];
const ALLOWED_STRIPE_CURRENCIES = ['EUR', 'USD'];

// Devise par pays, fallback si rien envoyé
const getCurrencyCodeByCountry = (country) => {
  const normalized = (country || "")
    .replace(/^[^\w]+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  switch (normalized) {
    case "cote d'ivoire": case "burkina faso": case "mali": case "senegal": return "XOF";
    case "cameroun": return "XAF";
    case "france": case "belgique": case "allemagne": return "EUR";
    case "usa": case "etats-unis": return "USD";
    case "canada": return "CAD";
    default: return "XOF";
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
 * Middleware AML principal
 * Sécurise chaque transaction avant exécution
 */
module.exports = async function amlMiddleware(req, res, next) {
  const provider = req.routedProvider || req.body.destination || req.body.provider;
  let { amount, toEmail, iban, phoneNumber, country } = req.body;
  // Devise expéditeur en priorité
  const currencySender = req.body.senderCurrencySymbol || req.body.currencySender;
  const currency = currencySender || req.body.currency || getCurrencyCodeByCountry(country);
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

    // 5. Pays à risque/sanctionné (ATTENTION: country doit être bien codé ISO/Alpha-2 ici)
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Pays à risque' });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // 6. Contrôle OFAC/ONU/SDN (optionnel)
    // if (
    //   await isSanctioned(senderCheck) ||
    //   await isSanctioned(recipientCheck)
    // ) {
    //   logger.error('[AML] OFAC/SDN detected sur sender ou destinataire', {
    //     user: user.email,
    //     sender: senderCheck,
    //     recipient: recipientCheck,
    //   });
    //   await logTransaction({
    //     userId: user._id, type: 'initiate', provider, amount, toEmail,
    //     details: maskSensitive(req.body), flagged: true, flagReason: 'OFAC/SDN sanctionné'
    //   });
    //   await sendFraudAlert({ user, type: 'ofac_sanction', provider });
    //   return res.status(403).json({
    //     error: "Utilisateur ou destinataire sous sanctions internationales (OFAC/ONU)."
    //   });
    // }

    // 7. Plafond AML par transaction
    const providerLimits = AML_LIMITS[provider] || {};
    let limit = providerLimits[currency];
    if (!limit) {
      logger.warn(`[AML] Limite non définie pour provider=${provider} currency=${currency}, fallback sur 10_000`);
      limit = 10_000; // Fallback si non renseigné
    }

    // 8. Challenge AML (question sécurité) si montant proche du plafond
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
        // Si c'est bon, on continue la suite du process AML
      }
    }

    // 9. Structuring, daily cap, volume (inclut la limite cumulée 24h)
    const stats = await getUserTransactionsStats(user._id, provider);
    const dailyCap = limit * 3;
    const futureTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + (amount || 0);

    if (futureTotal > dailyCap) {
      logger.warn('[AML] Plafond journalier dépassé', {
        provider, user: user.email, dailyTotal: stats.dailyTotal, tryAmount: amount, max: dailyCap, currency
      });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true,
        flagReason: `Plafond journalier dépassé (${stats.dailyTotal} + ${amount} > ${dailyCap} ${currency})`
      });
      return res.status(403).json({
        error: "Plafond journalier atteint pour ce type de transaction.",
        details: { max: dailyCap, currency, provider }
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

    // 10. Stripe : devise autorisée
    if (provider === 'stripe' && currency && !ALLOWED_STRIPE_CURRENCIES.includes(currency)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currency });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Devise interdite Stripe' });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currency });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // 11. ML scoring (optionnel, IA/anti-fraude avancé)
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user);
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Scoring ML élevé' });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({ error: "Transaction suspecte (analyse IA), contrôle manuel." });
      }
    }

    // 12. Log OK
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
