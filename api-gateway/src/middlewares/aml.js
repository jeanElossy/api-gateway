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


// Plafonds AML dynamiques par provider & devise
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
    EUR: 20_000,
    USD: 20_000,
    XOF: 10_000_000,
    XAF: 10_000_000,
    CAD: 20_000,
  }
};


// Pays à risque et devises autorisées Stripe
const RISKY_COUNTRIES = ['IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF', 'SO', 'YE', 'VE', 'LY'];
const ALLOWED_STRIPE_CURRENCIES = ['EUR', 'USD'];

// Utilitaires devise (à placer où tu veux ou importe-les)
const getCurrencyCodeByCountry = (country) => {
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
      return "XOF";
    case "cameroun":
      return "XAF";
    case "france":
    case "belgique":
    case "allemagne":
      return "EUR";
    case "usa":
    case "etats-unis":
      return "USD";
    case "canada":
      return "CAD";
    default:
      return "XOF";
  }
};

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

module.exports = async function amlMiddleware(req, res, next) {
  const provider = req.routedProvider || req.body.destination || req.body.provider;
  const { amount, toEmail, iban, phoneNumber, country, currency } = req.body;
  const user = req.user;

  try {
    // 1️⃣ Vérification utilisateur connecté
    if (!user || !user._id) {
      logger.warn('[AML] User manquant', { provider });
      await logTransaction({
        userId: null,
        type: 'initiate',
        provider: provider || 'inconnu',
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'User manquant',
      });
      return res.status(401).json({ error: "Authentification requise." });
    }

    // 2️⃣ Vérification KYC/KYB selon type de compte
    if (user.type === 'business' || user.isBusiness) {
      let kybStatus = user.kybStatus;
      if (typeof getBusinessKYBStatus === 'function') {
        kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
      }
      if (!kybStatus || kybStatus !== 'validé') {
        logger.warn('[AML] KYB insuffisant', { provider, user: user.email });
        await logTransaction({
          userId: user._id,
          type: 'initiate',
          provider,
          amount,
          toEmail,
          details: maskSensitive(req.body),
          flagged: true,
          flagReason: 'KYB insuffisant'
        });
        await sendFraudAlert({ user, type: 'kyb_insuffisant', provider });
        return res.status(403).json({ error: "KYB incomplet, transaction refusée." });
      }
    } else {
      // Particulier : KYC niveau 2 minimum
      if (!user.kycLevel || user.kycLevel < 2) {
        logger.warn('[AML] KYC insuffisant', { provider, user: user.email });
        await logTransaction({
          userId: user._id,
          type: 'initiate',
          provider,
          amount,
          toEmail,
          details: maskSensitive(req.body),
          flagged: true,
          flagReason: 'KYC insuffisant'
        });
        await sendFraudAlert({ user, type: 'kyc_insuffisant', provider });
        return res.status(403).json({ error: "KYC incomplet, transaction refusée." });
      }
    }

    // 3️⃣ Check PEP/sanction (OFAC, etc)
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error('[AML] PEP/Sanction detected', { user: user.email, reason: pepStatus.reason });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: pepStatus.reason
      });
      await sendFraudAlert({ user, type: 'pep_sanction', provider, reason: pepStatus.reason });
      return res.status(403).json({ error: "Transaction vers personne sanctionnée interdite." });
    }

    // 4️⃣ Blacklist mail/iban/phone
    if (
      (toEmail && blacklist.emails.includes(toEmail)) ||
      (iban && blacklist.ibans.includes(iban)) ||
      (phoneNumber && blacklist.phones.includes(phoneNumber))
    ) {
      logger.warn('[AML] Transaction vers cible blacklistée', { provider, toEmail, iban, phoneNumber });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Blacklist'
      });
      await sendFraudAlert({ user, type: 'blacklist', provider, toEmail, iban, phoneNumber });
      return res.status(403).json({ error: "Destinataire interdit (blacklist AML)." });
    }

    // 5️⃣ Pays à risque
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Pays à risque'
      });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // 6️⃣ Montant élevé/plafond dynamique (multi-devise/provider)
    const providerLimits = AML_LIMITS[provider] || {};
    const currencyUsed = currency || getCurrencyCodeByCountry(country);
    const limit = providerLimits[currencyUsed] || 10000; // fallback global

    if (typeof amount === 'number' && amount > limit) {
      logger.warn('[AML] Montant élevé détecté', { provider, user: user.email, amount, currency: currencyUsed, limit });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Montant élevé'
      });
      await sendFraudAlert({ user, type: 'montant_eleve', provider, amount, currency: currencyUsed });
      return res.status(403).json({
        error: "Montant trop élevé pour cette devise/provider. Vérification manuelle requise.",
        details: { max: limit, currency: currencyUsed, provider }
      });
    }

    // 7️⃣ Analyse de fréquence/structuring
    const stats = await getUserTransactionsStats(user._id, provider);
    if (stats && stats.lastHour > 10) {
      logger.warn('[AML] Volume suspect sur 1h', { provider, user: user.email, lastHour: stats.lastHour });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Volume élevé 1h'
      });
      await sendFraudAlert({ user, type: 'volume_1h', provider, count: stats.lastHour });
      return res.status(403).json({ error: "Trop de transactions sur 1h, vérification requise." });
    }
    if (stats && stats.dailyTotal > (limit * 3)) {
      logger.warn('[AML] Montant journalier anormal', { provider, user: user.email, dailyTotal: stats.dailyTotal });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Montant journalier élevé'
      });
      await sendFraudAlert({ user, type: 'daily_total', provider, amount: stats.dailyTotal });
      return res.status(403).json({ error: "Montant journalier élevé, contrôle AML." });
    }
    if (stats && stats.sameDestShortTime > 3) {
      logger.warn('[AML] Pattern structuring suspect', { provider, user: user.email, sameDestShortTime: stats.sameDestShortTime });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Pattern structuring'
      });
      await sendFraudAlert({ user, type: 'structuring', provider, count: stats.sameDestShortTime });
      return res.status(403).json({ error: "Pattern transactionnel suspect, vérification requise." });
    }

    // 8️⃣ Stripe : devise autorisée
    if (provider === 'stripe' && currencyUsed && !ALLOWED_STRIPE_CURRENCIES.includes(currencyUsed)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currency: currencyUsed });
      await logTransaction({
        userId: user._id,
        type: 'initiate',
        provider,
        amount,
        toEmail,
        details: maskSensitive(req.body),
        flagged: true,
        flagReason: 'Devise interdite Stripe'
      });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currency: currencyUsed });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // 9️⃣ Scoring Machine Learning AML (optionnel)
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user);
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({
          userId: user._id,
          type: 'initiate',
          provider,
          amount,
          toEmail,
          details: maskSensitive(req.body),
          flagged: true,
          flagReason: 'Scoring ML élevé'
        });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({ error: "Transaction suspecte (analyse IA), contrôle manuel." });
      }
    }

    // 🔟 Log AML même si tout passe (traçabilité)
    await logTransaction({
      userId: user._id,
      type: 'initiate',
      provider,
      amount,
      toEmail,
      details: maskSensitive(req.body),
      flagged: false,
      flagReason: ''
    });
    logger.info('[AML] AML OK', { provider, user: user.email, amount, toEmail, iban, phoneNumber, country, stats });

    // Passage à la suite si tout OK
    next();

  } catch (e) {
    // Gestion de toute exception inattendue dans le flux AML
    logger.error('[AML] Exception', { err: e, user: user?.email });
    await logTransaction({
      userId: user?._id,
      type: 'initiate',
      provider,
      amount,
      toEmail,
      details: maskSensitive(req.body),
      flagged: true,
      flagReason: 'Erreur système AML'
    });
    return res.status(500).json({ error: "Erreur système AML" });
  }
};
