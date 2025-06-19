// middlewares/aml.js

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
const {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
} = require('../tools/currency');
const { getDailyLimit, getSingleTxLimit } = require('../tools/amlLimits');

const RISKY_COUNTRIES = [
  'IR', 'KP', 'SD', 'SY', 'CU', 'RU', 'AF', 'SO', 'YE', 'VE', 'LY'
];
const ALLOWED_STRIPE_CURRENCIES = ["€", "$", "$USD"];

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
  let { amount, toEmail, iban, phoneNumber, country } = req.body;
  let currencyCode =
    req.body.currencyCode ||
    req.body.senderCurrencyCode ||
    req.body.currencySender ||
    (country ? getCurrencyCodeByCountry(country) : "USD");
  if (!currencyCode) currencyCode = "USD";
  const currencySymbol = getCurrencySymbolByCode(currencyCode);
  const user = req.user;

  if (typeof amount === "string") {
    amount = parseFloat(amount.replace(/\s/g, '').replace(',', '.'));
  }
  if (isNaN(amount) || !isFinite(amount)) amount = 0;

  try {
    // Auth
    if (!user || !user._id) {
      logger.warn('[AML] User manquant', { provider });
      await logTransaction({ userId: null, type: 'initiate', provider: provider || 'inconnu', amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'User manquant' });
      return res.status(401).json({ error: "Authentification requise." });
    }

    // KYC/KYB checks
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

    // PEP/Sanction
    const pepStatus = await getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber });
    if (pepStatus && pepStatus.sanctioned) {
      logger.error('[AML] PEP/Sanction detected', { user: user.email, reason: pepStatus.reason });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: pepStatus.reason });
      await sendFraudAlert({ user, type: 'pep_sanction', provider, reason: pepStatus.reason });
      return res.status(403).json({ error: "Transaction vers personne sanctionnée interdite." });
    }

    // Blacklist
    if ((toEmail && blacklist.emails.includes(toEmail)) ||
      (iban && blacklist.ibans.includes(iban)) ||
      (phoneNumber && blacklist.phones.includes(phoneNumber))) {
      logger.warn('[AML] Transaction vers cible blacklistée', { provider, toEmail, iban, phoneNumber });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Blacklist' });
      await sendFraudAlert({ user, type: 'blacklist', provider, toEmail, iban, phoneNumber });
      return res.status(403).json({ error: "Destinataire interdit (blacklist AML)." });
    }

    // Pays à risque
    if (country && RISKY_COUNTRIES.includes(country)) {
      logger.warn('[AML] Pays à risque/sanctionné détecté', { provider, user: user.email, country });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Pays à risque' });
      await sendFraudAlert({ user, type: 'pays_risque', provider, country });
      return res.status(403).json({ error: "Pays de destination interdit (AML)." });
    }

    // --- LIMITES PAR ENVOI ET PAR JOUR ---
    // 1. Limite "par envoi unique"
    const singleTxLimit = getSingleTxLimit(provider, currencySymbol) || getSingleTxLimit(provider, currencyCode);
    if (amount > singleTxLimit) {
      logger.warn('[AML] Plafond par transaction dépassé', {
        provider, user: user.email, tryAmount: amount, max: singleTxLimit, currencySymbol
      });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true,
        flagReason: `Plafond par transaction dépassé (${amount} > ${singleTxLimit} ${currencySymbol})`
      });
      return res.status(403).json({
        error: `Le plafond autorisé par transaction est de ${singleTxLimit} ${currencySymbol} pour ce moyen de paiement. Merci de réduire le montant ou de contacter le support.`,
        details: { max: singleTxLimit, currency: currencySymbol, provider }
      });
    }

    // 2. Limite journalière
    const dailyLimit = getDailyLimit(provider, currencySymbol) || getDailyLimit(provider, currencyCode);
    const stats = await getUserTransactionsStats(user._id, provider, currencySymbol);
    const futureTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + (amount || 0);
    if (futureTotal > dailyLimit) {
      logger.warn('[AML] Plafond journalier dépassé', {
        provider, user: user.email, dailyTotal: stats.dailyTotal, tryAmount: amount, max: dailyLimit, currencySymbol
      });
      await logTransaction({
        userId: user._id, type: 'initiate', provider, amount, toEmail,
        details: maskSensitive(req.body), flagged: true,
        flagReason: `Plafond journalier dépassé (${stats.dailyTotal} + ${amount} > ${dailyLimit} ${currencySymbol})`
      });
      return res.status(403).json({
        error: `Le plafond journalier autorisé est atteint pour la devise ${currencySymbol}. Vous ne pouvez plus effectuer de nouvelles transactions aujourd'hui avec ce moyen de paiement. Réessayez demain ou contactez le support.`,
        details: { max: dailyLimit, currency: currencySymbol, provider }
      });
    }

    // Challenge AML (montant proche du plafond)
    const userQuestions = user.securityQuestions || [];
    const needAmlChallenge = typeof amount === 'number' && amount >= dailyLimit * 0.9 && userQuestions.length > 0;
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

    // Limites de pattern (structuring, volume horaire, etc)
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

    // Stripe : devise autorisée
    if (provider === 'stripe' && currencySymbol && !ALLOWED_STRIPE_CURRENCIES.includes(currencySymbol)) {
      logger.warn('[AML] Devise non autorisée pour Stripe', { user: user.email, currencySymbol });
      await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Devise interdite Stripe' });
      await sendFraudAlert({ user, type: 'devise_interdite', provider, currencySymbol });
      return res.status(403).json({ error: "Devise non autorisée." });
    }

    // ML scoring (optionnel)
    if (typeof getMLScore === 'function') {
      const score = await getMLScore(req.body, user);
      if (score && score >= 0.9) {
        logger.warn('[AML] ML scoring élevé', { user: user.email, score });
        await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Scoring ML élevé' });
        await sendFraudAlert({ user, type: 'ml_suspect', provider, score });
        return res.status(403).json({
          error: "Votre transaction est temporairement bloquée pour vérification supplémentaire (sécurité renforcée). Notre équipe analyse automatiquement les transactions suspectes. Merci de réessayer plus tard ou contactez le support si besoin."
        });
      }
    }

    // Log OK
    await logTransaction({ userId: user._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: false, flagReason: '' });
    logger.info('[AML] AML OK', { provider, user: user.email, amount, toEmail, iban, phoneNumber, country, stats });

    next();
  } catch (e) {
    logger.error('[AML] Exception', { err: e, user: user?.email });
    await logTransaction({ userId: user?._id, type: 'initiate', provider, amount, toEmail, details: maskSensitive(req.body), flagged: true, flagReason: 'Erreur système AML' });
    return res.status(500).json({ error: "Erreur système AML" });
  }
};
