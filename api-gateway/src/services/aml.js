// File: services/aml.js

const AMLLog = require('../models/AMLLog');
const Transaction = require('../models/Transaction');
const {
  AML_SINGLE_TX_LIMITS,
  AML_DAILY_LIMITS,
  getSingleTxLimit,
  getDailyLimit,
} = require('../tools/amlLimits');

async function logTransaction({
  userId,
  type,
  provider,
  amount,
  toEmail,
  details,
  flagged = false,
  flagReason = '',
  transactionId = null,
  ip = null,
}) {
  if (!userId || !provider) {
    console.error('[AML-LOG] userId ou provider manquant pour AMLLog:', { userId, provider, type, amount, toEmail });
    return;
  }
  try {
    await AMLLog.create({
      userId,
      type,
      provider,
      amount,
      toEmail,
      details,
      flagged,
      flagReason,
      reviewed: false,
      transactionId,
      ip,
      loggedAt: new Date()
    });
  } catch (e) {
    console.error('[AML-LOG] Failed to record log', e);
  }
}

async function getUserTransactionsStats(userId, provider, currency = null) {
  // Transactions sur la dernière heure (volume)
  const lastHour = await Transaction.countDocuments({
    userId,
    provider,
    ...(currency ? { currency } : {}),
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
  });

  // Montant total sur 24h (daily cap, multi-devise possible)
  const matchQuery = {
    userId,
    provider,
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  };
  if (currency) matchQuery.currency = currency;
  const dailyTotalAgg = await Transaction.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, total: { $sum: "$amount" } } }
  ]);
  const dailyTotal = dailyTotalAgg.length ? dailyTotalAgg[0].total : 0;

  // Structuring : nb vers même destinataire sur 10min
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const recentTx = await Transaction.find({
    userId,
    provider,
    ...(currency ? { currency } : {}),
    createdAt: { $gte: cutoff }
  });
  const destCount = {};
  recentTx.forEach(tx => {
    const key = tx.toEmail || tx.toIBAN || tx.toPhone || 'none';
    destCount[key] = (destCount[key] || 0) + 1;
  });
  const sameDestShortTime = Math.max(...Object.values(destCount), 0);

  return { lastHour, dailyTotal, sameDestShortTime };
}

async function getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber }) {
  if (
    user.email === 'ministere@etat.gov' ||
    (toEmail && toEmail.endsWith('@etat.gov'))
  ) {
    return { sanctioned: true, reason: 'Utilisateur/personne politiquement exposée (PEP)' };
  }
  return { sanctioned: false };
}

async function getMLScore(payload, user) {
  const provider = payload.provider || payload.destination || "paynoval";
  const currency =
    payload.senderCurrencySymbol ||
    payload.currencySender ||
    payload.currency ||
    "F CFA";
  // **Ici on utilise le plafond single transaction**
  const singleLimit = getSingleTxLimit(provider, currency);

  if (payload.amount > singleLimit) return 0.92;
  return Math.random() * 0.4;
}

async function getBusinessKYBStatus(businessId) {
  return "validé";
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
  getSingleTxLimit,
  getDailyLimit,
};
