const logger = require('../logger');
const {
  getUserKYCLevel,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  logTransaction,
  getMLScore,
  getBusinessKYBStatus, // Ajoute si tu as une fonction KYB côté service
} = require('../services/aml');
const blacklist = require('../aml/blacklist.json');
const { sendFraudAlert } = require('../utils/alert');

// Pays à risque, blacklist, devises, etc.
const RISKY_COUNTRIES = [
  'IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF',
  'SO', 'YE', 'VE', 'LY'
];
const ALLOWED_STRIPE_CURRENCIES = ['EUR', 'USD'];

// Helper pour masquer les infos sensibles dans les logs/meta
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
  const {
    provider, amount, toEmail, iban, phoneNumber, country, currency
  } = req.body;
  const user = req.user;

  try {
    // ----------- 1. Vérification utilisateur, KYC/KYB -----------
    if (!user) {
      logger.warn('[AML] User manquant', { provider });
      await logTransaction({
        userId: null, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'User manquant'
      });
      return res.status(401).json({ error: "Authentification requise." });
    }

    // Si entreprise, vérification KYB (et non KYC)
    if (user.type === 'business' || user.isBusiness) {
      let kybStatus = user.kybStatus;
      // Optionnel : tu peux fetcher en BDD ou API via getBusinessKYBStatus
      if (typeof getBusinessKYBStatus === 'function') {
        kybStatus = await getBusinessKYBStatus(user.businessId || user._id);
      }
      if (!kybStatus || kybStatus !== 'validé') {
        logger.warn('[AML] KYB insuffisant', { provider, user: user?.email });
        await logTransaction({
          userId: user?._id, type: 'initiate', provider, amount, toEmail,
          details: maskSensitive(req.body), flagged: true, flagReason: 'KYB insuffisant'
        });
        await sendFraudAlert({ user, type: 'kyb_insuffisant', provider });
        return res.status(403).json({ error: "KYB incomplet, transaction refusée." });
      }
    } else {
      // Individuel (KYC)
      if (!user.kycLevel || user.kycLevel < 2) {
        logger.warn('[AML] KYC insuffisant', { provider, user: user?.email });
        await logTransaction({
          userId: user?._id, type: 'initiate', provider, amount, toEmail,
          details: maskSensitive(req.body), flagged: true, flagReason: 'KYC insuffisant'
        });
        await sendFraudAlert({ user, type: 'kyc_insuffisant', provider });
        return res.status(403).json({ error: "KYC incomplet, transaction refusée." });
      }
    }

    // ----------- 2. PEP/sanction (client/destinataire) -----------
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error('[AML] PEP/Sanction detected', { user: user.email, reason: pepStatus.reason });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: pepStatus.reason
      });
      await sendFraudAlert({ user, type: 'pep_sanction', provider, reason: pepStatus.reason });
      return res.status(403).json({ error: "Transaction vers personne sanctionnée interdite." });
    }

    // ----------- 3. Blacklists -----------
    if (
      (toEmail && blacklist.emails.includes(toEmail)) ||
      (iban && blacklist.ibans.includes(iban)) ||
      (phoneNumber && blacklist.phones.includes(phoneNumber))
    ) {
      logger.warn('[AML] Transaction vers cible blacklistée', { provider, toEmail, iban, phoneNumber });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Blacklist'
      });
      await sendFraudAlert({ user, type: 'blacklist', provider, toEmail, iban, phoneNumber });
      return res.status(403).json({ error: "Destinataire interdit (blacklist AML)." });
    }

    // ----------- 4. Pays à risque -----------
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Pays à risque'
      });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // ----------- 5. Montant élevé / plafonds contextuels -----------
    const LIMITS = {
      paynoval: 5000,
      stripe: 10000,
      bank: 20000,
      mobilemoney: 2000,
    };
    if (amount > (LIMITS[provider] || 10000)) {
      logger.warn('[AML] Montant élevé détecté', { provider, user: user.email, amount });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Montant élevé'
      });
      await sendFraudAlert({ user, type: 'montant_eleve', provider, amount });
      return res.status(403).json({ error: "Montant trop élevé, vérification manuelle requise." });
    }

    // ----------- 6. Rythme/frequence structuring -----------
    const stats = await getUserTransactionsStats(user._id, provider);
    if (stats && stats.lastHour > 10) {
      logger.warn('[AML] Volume suspect sur 1h', { provider, user: user.email, lastHour: stats.lastHour });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Volume élevé 1h'
      });
      await sendFraudAlert({ user, type: 'volume_1h', provider, count: stats.lastHour });
      return res.status(403).json({ error: "Trop de transactions sur 1h, vérification requise." });
    }
    if (stats && stats.dailyTotal > (LIMITS[provider] * 3)) {
      logger.warn('[AML] Montant journalier anormal', { provider, user: user.email, dailyTotal: stats.dailyTotal });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Montant journalier élevé'
      });
      await sendFraudAlert({ user, type: 'daily_total', provider, amount: stats.dailyTotal });
      return res.status(403).json({ error: "Montant journalier élevé, contrôle AML." });
    }
    if (stats && stats.sameDestShortTime > 3) {
      logger.warn('[AML] Pattern structuring suspect', { provider, user: user.email, sameDestShortTime: stats.sameDestShortTime });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Pattern structuring'
      });
      await sendFraudAlert({ user, type: 'structuring', provider, count: stats.sameDestShortTime });
      return res.status(403).json({ error: "Pattern transactionnel suspect, vérification requise." });
    }

    // ----------- 7. Devise spécifique Stripe -----------
    if (provider === 'stripe' && currency && !ALLOWED_STRIPE_CURRENCIES.includes(currency)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currency });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true, flagReason: 'Devise interdite Stripe'
      });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currency });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // ----------- 8. ML scoring (optionnel) -----------
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user); // [0,1]
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({
          userId: user._id, type: 'initiate', provider, amount, toEmail,
          details: maskSensitive(req.body), flagged: true, flagReason: 'Scoring ML élevé'
        });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({ error: "Transaction suspecte (analyse IA), contrôle manuel." });
      }
    }

    // ----------- 9. Log AML même si passage OK -----------
    await logTransaction({
      userId: user._id, type: 'initiate', provider, amount, toEmail,
      details: maskSensitive(req.body), flagged: false, flagReason: ''
    });
    logger.info('[AML] AML OK', {
      provider, user: user.email, amount, toEmail, iban, phoneNumber, country, stats,
    });

    next();
  } catch (e) {
    logger.error('[AML] Exception', { err: e, user: user?.email });
    await logTransaction({
      userId: user?._id, type: 'initiate', provider, amount, toEmail,
      details: maskSensitive(req.body), flagged: true, flagReason: 'Erreur système AML'
    });
    return res.status(500).json({ error: "Erreur système AML" });
  }
};
