const AMLLog = require('../models/AMLLog');
const Transaction = require('../models/Transaction');

/**
 * Log AML avec validation stricte.
 */
async function logTransaction({
  userId,
  type,
  provider,
  amount,
  toEmail,
  details,
  flagged = false,
  flagReason = ''
}) {
  if (!userId || !provider) {
    // Evite log DB avec data incohérente (sinon Mongoose crash)
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
      reviewed: false
    });
  } catch (e) {
    console.error('[AML-LOG] Failed to record log', e);
  }
}

/**
 * Statistiques AML avancées sur les transactions utilisateur
 */
async function getUserTransactionsStats(userId, provider) {
  // Nb de transactions sur la dernière heure
  const lastHour = await Transaction.countDocuments({
    userId,
    provider,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
  });

  // Montant total sur 24h
  const dailyTotalAgg = await Transaction.aggregate([
    { $match: {
        userId,
        provider,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    },
    { $group: { _id: null, total: { $sum: "$amount" } } }
  ]);
  const dailyTotal = dailyTotalAgg.length ? dailyTotalAgg[0].total : 0;

  // Structuring sur 10min
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const recentTx = await Transaction.find({
    userId,
    provider,
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
 * Vérifie si user ou destinataire est PEP ou sanctionné.
 */
async function getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber }) {
  // Simulé : email gouvernemental = PEP
  if (
    user.email === 'ministere@etat.gov' ||
    (toEmail && toEmail.endsWith('@etat.gov'))
  ) {
    return { sanctioned: true, reason: 'Utilisateur/personne politiquement exposée (PEP)' };
  }
  // Ajoute ici appel API réelle (DowJones, World-Check, OFAC...)
  return { sanctioned: false };
}

/**
 * (Facultatif) Scoring IA, plug ton moteur ML ici.
 */
async function getMLScore(payload, user) {
  if (payload.amount > 7000) return 0.92;
  return Math.random() * 0.4;
}

async function getBusinessKYBStatus(businessId) {
  return "validé"; // ou "en_attente", "refusé", etc.
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
};
