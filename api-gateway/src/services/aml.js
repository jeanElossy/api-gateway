// File: services/aml.js

const AMLLog = require('../models/AMLLog');
const Transaction = require('../models/Transaction');

/**
 * Enregistre un log AML, protège contre data incohérente.
 * Ajoute reviewed: false par défaut pour le suivi admin.
 */
async function logTransaction({
  userId,
  type,
  provider,
  amount,
  toEmail,
  details,
  flagged = false,
  flagReason = '',
  transactionId = null, // Optionnel : pour lier au doc transaction
  ip = null,            // Optionnel : enrichissement trace
}) {
  if (!userId || !provider) {
    // Évite log DB incohérent (empêche crash Mongoose)
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

/**
 * Statistiques AML avancées sur les transactions utilisateur.
 * Gère lastHour, dailyTotal (par devise) et structuring (pattern).
 */
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

  // Structuring : nb vers même destinataire sur 10min
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

/**
 * Vérifie si l’utilisateur ou le destinataire est PEP/sanctionné.
 * Peut être relié à DowJones, World-Check, OFAC etc.
 */
async function getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber }) {
  // Simulé : email gouvernemental = PEP (pour test)
  if (
    user.email === 'ministere@etat.gov' ||
    (toEmail && toEmail.endsWith('@etat.gov'))
  ) {
    return { sanctioned: true, reason: 'Utilisateur/personne politiquement exposée (PEP)' };
  }
  // Pour la prod, plug ici une API AML externe si dispo.
  return { sanctioned: false };
}

/**
 * (Optionnel) Scoring IA : plug ta logique ML ici.
 * Ex : anti-fraude IA, modèles TensorFlow/Python etc.
 */
async function getMLScore(payload, user) {
  // Démo : au-delà de 7000 = high risk.
  if (payload.amount > 7000) return 0.92;
  return Math.random() * 0.4;
}

/**
 * Statut KYB business (dummy version, à brancher sur ta vraie DB si besoin)
 */
async function getBusinessKYBStatus(businessId) {
  // Branche sur ta vraie base/logic si tu as plusieurs statuts.
  return "validé"; // ou "en_attente", "refusé", etc.
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
};
