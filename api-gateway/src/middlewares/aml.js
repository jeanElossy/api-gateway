const logger = require('../logger');
const {
  getUserKYCLevel,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  logTransaction,
  getMLScore
} = require('../services/aml');
const blacklist = require('../aml/blacklist.json');
const { sendFraudAlert } = require('../utils/alert');

const RISKY_COUNTRIES = [
  'IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF', // Pays sous sanctions
  'SO', 'YE', 'VE', 'LY'
];
const ALLOWED_STRIPE_CURRENCIES = ['EUR', 'USD'];

module.exports = async function amlMiddleware(req, res, next) {
  const {
    provider, amount, toEmail, iban, phoneNumber, country, currency
  } = req.body;
  const user = req.user;

  try {
    // 1️⃣ KYC/KYB/PEP/Sanction check
    if (!user || user.kycLevel < 2) {
      logger.warn('[AML] KYC/KYB insuffisant', { provider, user: user?.email });
      await logTransaction({ userId: user?._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'KYC insuffisant' });
      await sendFraudAlert({ user, type: 'kyc_insuffisant', provider });
      return res.status(403).json({ error: "KYC/KYB incomplet, transaction refusée." });
    }
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error('[AML] PEP/Sanction detected', { user: user.email, reason: pepStatus.reason });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: pepStatus.reason });
      await sendFraudAlert({ user, type: 'pep_sanction', provider, reason: pepStatus.reason });
      return res.status(403).json({ error: "Transaction vers personne sanctionnée interdite." });
    }

    // 2️⃣ Blacklists (emails, IBAN, phones)
    if (
      (toEmail && blacklist.emails.includes(toEmail)) ||
      (iban && blacklist.ibans.includes(iban)) ||
      (phoneNumber && blacklist.phones.includes(phoneNumber))
    ) {
      logger.warn('[AML] Transaction vers cible blacklistée', { provider, toEmail, iban, phoneNumber });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Blacklist' });
      await sendFraudAlert({ user, type: 'blacklist', provider, toEmail, iban, phoneNumber });
      return res.status(403).json({ error: "Destinataire interdit (blacklist AML)." });
    }

    // 3️⃣ Pays à risque
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Pays à risque' });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // 4️⃣ Montant suspect ou plafond contextuel
    const LIMITS = {
      paynoval: 5000,
      stripe: 10000,
      bank: 20000,
      mobilemoney: 2000,
    };
    if (amount > (LIMITS[provider] || 10000)) {
      logger.warn('[AML] Montant élevé détecté', { provider, user: user.email, amount });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Montant élevé' });
      await sendFraudAlert({ user, type: 'montant_eleve', provider, amount });
      return res.status(403).json({ error: "Montant trop élevé, vérification manuelle requise." });
    }

    // 5️⃣ Surveillance du rythme/frequence, structuring, etc.
    const stats = await getUserTransactionsStats(user._id, provider);
    if (stats && stats.lastHour > 10) {
      logger.warn('[AML] Volume suspect sur 1h', { provider, user: user.email, lastHour: stats.lastHour });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Volume élevé 1h' });
      await sendFraudAlert({ user, type: 'volume_1h', provider, count: stats.lastHour });
      return res.status(403).json({ error: "Trop de transactions sur 1h, vérification requise." });
    }
    if (stats && stats.dailyTotal > (LIMITS[provider] * 3)) {
      logger.warn('[AML] Montant journalier anormal', { provider, user: user.email, dailyTotal: stats.dailyTotal });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Montant journalier élevé' });
      await sendFraudAlert({ user, type: 'daily_total', provider, amount: stats.dailyTotal });
      return res.status(403).json({ error: "Montant journalier élevé, contrôle AML." });
    }
    if (stats && stats.sameDestShortTime > 3) {
      logger.warn('[AML] Pattern structuring suspect', { provider, user: user.email, sameDestShortTime: stats.sameDestShortTime });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Pattern structuring' });
      await sendFraudAlert({ user, type: 'structuring', provider, count: stats.sameDestShortTime });
      return res.status(403).json({ error: "Pattern transactionnel suspect, vérification requise." });
    }

    // 6️⃣ Règles spécifiques provider
    if (provider === 'stripe' && currency && !ALLOWED_STRIPE_CURRENCIES.includes(currency)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currency });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Devise interdite Stripe' });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currency });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // 7️⃣ Scoring ML (optionnel)
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user); // [0,1] ou objet
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Scoring ML élevé' });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({ error: "Transaction suspecte (analyse IA), contrôle manuel." });
      }
    }

    // 8️⃣ Log AML même si passage OK
    await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: false, flagReason: '' });
    logger.info('[AML] AML OK', {
      provider, user: user.email, amount, toEmail, iban, phoneNumber, country, stats,
    });

    next();
  } catch (e) {
    logger.error('[AML] Exception', { err: e, user: user?.email });
    await logTransaction({ userId: user?._id, type: 'initiate', provider, amount, toEmail, details: req.body, flagged: true, flagReason: 'Erreur système AML' });
    return res.status(500).json({ error: "Erreur système AML" });
  }
};
