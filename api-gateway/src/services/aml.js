// File: services/aml.js
"use strict";

const AMLLog = require("../models/AMLLog");
const Transaction = require("../models/Transaction");

const {
  getSingleTxLimit,
  getDailyLimit,
} = require("../tools/amlLimits");

const { getCurrencySymbolByCode } = require("../tools/currency");

// -------------------------
// Helpers
// -------------------------
function safeProvider(v) {
  const p = String(v || "").trim().toLowerCase();
  return p || "paynoval";
}

function normalizeCurrencyISO(v) {
  const s0 = String(v || "").trim().toUpperCase();
  if (!s0) return "";

  const s = s0.replace(/\u00A0/g, " ");

  // CFA
  if (s === "FCFA" || s === "CFA" || s === "F CFA" || s.includes("CFA")) return "XOF";

  // symboles directs
  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  if (s === "£") return "GBP";

  // $CAD / CAD$ / $USD / USD$ / US$
  const letters = s.replace(/[^A-Z]/g, "");
  if (letters === "CAD") return "CAD";
  if (letters === "USD") return "USD";
  if (letters === "EUR") return "EUR";
  if (letters === "GBP") return "GBP";
  if (letters === "XOF") return "XOF";
  if (letters === "XAF") return "XAF";

  if (/^[A-Z]{3}$/.test(letters)) return letters;
  if (/^[A-Z]{3}$/.test(s)) return s;

  return "";
}

function parseAmount(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/\s/g, "").replace(",", ".").trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Retourne un filtre Mongo pour currency qui accepte :
 * - currency = ISO (XOF/EUR/USD/CAD)
 * - OU currency = symbole ("F CFA", "€", "$CAD", "$")
 *
 * Si currencyInput est déjà un symbole, on génère aussi l'ISO possible.
 * Si currencyInput est ISO, on génère aussi le symbole.
 */
function buildCurrencyMatch(currencyInput) {
  if (!currencyInput) return null;

  const raw = String(currencyInput).trim();
  if (!raw) return null;

  const iso = normalizeCurrencyISO(raw); // ISO si possible
  const symbolFromIso = iso ? getCurrencySymbolByCode(iso) : "";
  const candidates = new Set();

  // original
  candidates.add(raw);

  // ISO + symbol
  if (iso) candidates.add(iso);
  if (symbolFromIso) candidates.add(symbolFromIso);

  // cas particuliers si Transaction stocke "$USD" au lieu de "$" etc.
  // On ajoute quelques formes "compat"
  if (iso === "USD") {
    candidates.add("$");
    candidates.add("$USD");
  }
  if (iso === "CAD") {
    candidates.add("$CAD");
  }
  if (iso === "EUR") {
    candidates.add("€");
  }
  if (iso === "XOF" || iso === "XAF") {
    candidates.add("F CFA");
    candidates.add("FCFA");
    candidates.add("CFA");
  }

  const arr = Array.from(candidates).filter(Boolean);

  // filtre $in si plusieurs
  if (arr.length === 1) return { currency: arr[0] };
  return { currency: { $in: arr } };
}

// -------------------------
// AML LOG
// -------------------------
async function logTransaction({
  userId,
  type,
  provider,
  amount,
  toEmail,
  details,
  flagged = false,
  flagReason = "",
  transactionId = null,
  ip = null,
}) {
  const prov = safeProvider(provider);

  // tu avais un "return" si userId/provider manquant.
  // Je garde la sécurité mais je log en console clairement.
  if (!userId) {
    console.error("[AML-LOG] userId manquant pour AMLLog:", {
      userId,
      provider: prov,
      type,
      amount,
      toEmail,
    });
    return;
  }

  try {
    await AMLLog.create({
      userId,
      type,
      provider: prov,
      amount,
      toEmail,
      details,
      flagged,
      flagReason,
      reviewed: false,
      transactionId,
      ip,
      loggedAt: new Date(),
    });
  } catch (e) {
    console.error("[AML-LOG] Failed to record log", e?.message || e);
  }
}

// -------------------------
// STATS (rate limit, daily cap, structuring)
// -------------------------
async function getUserTransactionsStats(userId, provider, currency = null) {
  const prov = safeProvider(provider);

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

  const currencyMatch = buildCurrencyMatch(currency);

  // 1) Transactions sur la dernière heure (volume)
  const lastHourQuery = {
    userId,
    provider: prov,
    createdAt: { $gte: hourAgo },
    ...(currencyMatch || {}),
  };
  const lastHour = await Transaction.countDocuments(lastHourQuery);

  // 2) Montant total sur 24h
  const matchQuery = {
    userId,
    provider: prov,
    createdAt: { $gte: dayAgo },
    ...(currencyMatch || {}),
  };

  const dailyTotalAgg = await Transaction.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);

  const dailyTotal = dailyTotalAgg.length ? dailyTotalAgg[0].total : 0;

  // 3) Structuring : nb vers même destinataire sur 10min
  const recentQuery = {
    userId,
    provider: prov,
    createdAt: { $gte: tenMinAgo },
    ...(currencyMatch || {}),
  };

  const recentTx = await Transaction.find(recentQuery)
    .select("toEmail toIBAN toPhone")
    .lean();

  const destCount = {};
  for (const tx of recentTx) {
    const key = tx.toEmail || tx.toIBAN || tx.toPhone || "none";
    destCount[key] = (destCount[key] || 0) + 1;
  }
  const sameDestShortTime = Object.keys(destCount).length ? Math.max(...Object.values(destCount)) : 0;

  return { lastHour, dailyTotal, sameDestShortTime };
}

// -------------------------
// PEP/Sanction (demo)
// -------------------------
async function getPEPOrSanctionedStatus(user, { toEmail, iban, phoneNumber }) {
  if (
    user?.email === "ministere@etat.gov" ||
    (toEmail && String(toEmail).endsWith("@etat.gov"))
  ) {
    return { sanctioned: true, reason: "Utilisateur/personne politiquement exposée (PEP)" };
  }
  return { sanctioned: false };
}

// -------------------------
// ML scoring (optionnel / demo)
// -------------------------
async function getMLScore(payload = {}, user) {
  const provider = safeProvider(payload.provider || payload.destination || payload.funds || "paynoval");

  // ✅ on priorise ISO
  const currencyISO =
    normalizeCurrencyISO(payload.currencySource) ||
    normalizeCurrencyISO(payload.currencyCode) ||
    normalizeCurrencyISO(payload.senderCurrencyCode) ||
    normalizeCurrencyISO(payload.currencySender) ||
    normalizeCurrencyISO(payload.currency) ||
    normalizeCurrencyISO(payload.selectedCurrency) ||
    "XOF"; // fallback raisonnable (tu peux mettre "USD" si tu préfères)

  const amount = parseAmount(payload.amountSource ?? payload.amount);

  // ✅ plafond single transaction sur ISO
  const singleLimit = getSingleTxLimit(provider, currencyISO);

  // exemple simple : si dépasse, score haut
  if (amount > singleLimit) return 0.92;

  // score "faible" pseudo aléatoire
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
