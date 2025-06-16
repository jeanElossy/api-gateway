const AMLLog = require('../models/AMLLog');
const Transaction = require('../models/Transaction');
const blacklist = require('../aml/blacklist.json');

/**
 * Enregistre chaque transaction AML (audit trail, compliance).
 * 
 * @param {Object} param0 
 * @returns {Promise<void>}
 */
async function logTransaction({
  userId,
  type,        // "initiate", "confirm", "cancel"
  provider,    // "paynoval", "stripe", "bank", "mobilemoney"
  amount,
  toEmail,
  details,     // snapshot: iban, phone, pays, meta, etc. (attention : maskSensitive côté appelant !)
  flagged = false,
  flagReason = ''
}) {
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
      reviewed: false, // pas encore examiné par compliance
    });
  } catch (e) {
    console.error('[AML-LOG] Failed to record log', e);
  }
}

/**
 * Statistiques AML avancées sur les transactions utilisateur
 * - lastHour : nb sur 1h
 * - dailyTotal : somme sur 24h
 * - sameDestShortTime : structuring sur 10min
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
        userId: userId,
        provider: provider,
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    },
    { $group: { _id: null, total: { $sum: "$amount" } } }
  ]);
  const dailyTotal = dailyTotalAgg.length ? dailyTotalAgg[0].total : 0;

  // Structuring : nb de fois même destinataire sur 10min
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
 * (Plug API World-Check, DowJones, sanctions OFAC, etc. ici)
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
  // Ex : au-dessus d’un seuil, on simule du risque
  if (payload.amount > 7000) return 0.92;
  // À brancher avec une vraie API si besoin
  return Math.random() * 0.4;
}

// (Facultatif) Exemple de check KYB distant (à implémenter selon ta logique)
async function getBusinessKYBStatus(businessId) {
  // Branche une requête à ton système KYB si existant
  // Ex : trouve la fiche entreprise, vérifie status = "validé"
  // Simulé ici :
  return "validé"; // ou "en_attente", "refusé", etc.
}

module.exports = {
  logTransaction,
  getUserTransactionsStats,
  getPEPOrSanctionedStatus,
  getMLScore,
  getBusinessKYBStatus,
};
