const AMLLog = require('../models/AMLLog');
const Transaction = require('../models/Transaction');
const blacklist = require('../aml/blacklist.json');

// Logger chaque transaction (AML audit trail)
async function logTransaction({ userId, type, provider, amount, toEmail, details, flagged = false, flagReason = '' }) {
  try {
    await AMLLog.create({
      userId,
      type,             // "initiate", "confirm", "cancel"
      provider,         // "paynoval", "stripe", "bank", "mobilemoney"
      amount,
      toEmail,
      details,          // snapshot: iban, phone, country, meta, etc.
      flagged,
      flagReason,
      reviewed: false,  // pas encore examiné
    });
  } catch (e) {
    console.error('[AML-LOG] Failed to record log', e);
  }
}

// Statistiques transactionnelles avancées
async function getUserTransactionsStats(userId, provider) {
  // Nombre de transactions sur 1h
  const lastHour = await Transaction.countDocuments({
    userId,
    provider,
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
  });
  // Montant total sur 24h
  const dailyTotalAgg = await Transaction.aggregate([
    { $match: {
        userId: userId,
        provider: provider,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    },
    { $group: { _id: null, total: { $sum: "$amount" } } }
  ]);
  const dailyTotal = dailyTotalAgg.length ? dailyTotalAgg[0].total : 0;

  // Structuring
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

// Vérifie PEP/sanction (API externe simulée)
async function getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber }) {
  // Ex : Plugge sur API sanctionnlist / PEP réel
  if (
    user.email === 'ministere@etat.gov' ||
    (toEmail && toEmail.endsWith('@etat.gov'))
  ) {
    return { sanctioned: true, reason: 'Utilisateur/personne politiquement exposée (PEP)' };
  }
  // Ajoute ici appel API réelle (DowJones, World-Check, etc.)
  return { sanctioned: false };
}

// (Facultatif) ML scoring plug
async function getMLScore(payload, user) {
  // Branche ici un endpoint IA si besoin
  if (payload.amount > 7000) return 0.92;
  return Math.random() * 0.4;
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore
};
