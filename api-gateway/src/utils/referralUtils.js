// File: api-gateway/src/utils/referralUtils.js
"use strict";

const axios = require("axios");
const crypto = require("crypto");
const logger = require("../logger") || console;
const config = require("../config");
const Transaction = require("../models/Transaction");

// URL du backend principal
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || "").replace(/\/+$/, "");

// Token interne partagé avec le backend principal
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || "";

/* -----------------------
 * Helpers
 * ----------------------- */
const safeNumber = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

const isConfirmedStatus = (s) => {
  const st = String(s || "").toLowerCase();
  return st === "confirmed" || st === "success" || st === "validated" || st === "completed";
};

const buildHeaders = (authToken) => ({
  ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {}),
  ...(authToken ? { Authorization: authToken } : {}),
});

async function postInternal(paths, payload, authToken) {
  if (!PRINCIPAL_URL) throw new Error("PRINCIPAL_URL manquant");

  let lastErr = null;
  for (const p of paths) {
    const url = `${PRINCIPAL_URL}${p}`;
    try {
      const res = await axios.post(url, payload, { headers: buildHeaders(authToken), timeout: 8000 });
      return { ok: true, data: res.data, path: p };
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      // 404 => on tente le next path
      if (status === 404) continue;
      // 401/403 peut arriver si token pas configuré => on continue aussi
      if (status === 401 || status === 403) continue;
      // sinon on garde et continue quand même
      continue;
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Nettoie le nom du pays : remplace entités HTML et supprime caractères non alphabétiques initiaux
 */
function cleanCountry(raw) {
  if (typeof raw !== "string") return "";
  const step1 = raw.replace(/&#x27;/g, "'");
  return step1.replace(/^[^\p{L}]*/u, "");
}

/**
 * Normalise le nom du pays : retire accents, apostrophes spéciales, met en minuscule
 */
function normalizeCountry(str) {
  if (typeof str !== "string") return "";
  const noAccents = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return noAccents.replace(/’/g, "'").trim().toLowerCase();
}

/**
 * Listes de pays par région (normalisés)
 */
const AMERICA_COUNTRIES = ["canada", "usa", "united states", "united states of america"];

const EUROPE_COUNTRIES = ["france", "belgique", "belgium", "allemagne", "germany"];

const AFRICA_COUNTRIES = [
  "cote d'ivoire",
  "cote d ivoire",
  "cote divoire",
  "cote-d-ivoire",
  "mali",
  "burkina faso",
  "senegal",
  "cameroun",
  "cameroon",
  "benin",
  "togo",
  "ghana",
];

function getRegionFromCountry(countryRaw) {
  const normalized = normalizeCountry(cleanCountry(countryRaw));
  if (!normalized) return null;

  if (AMERICA_COUNTRIES.includes(normalized)) return "AMERICA";
  if (EUROPE_COUNTRIES.includes(normalized)) return "EUROPE";
  if (AFRICA_COUNTRIES.includes(normalized)) return "AFRICA";

  return null;
}

/**
 * Seuils selon la région du FILLEUL (2 premiers transferts cumulés)
 */
const THRESHOLDS_BY_REGION = {
  AMERICA: { currency: "CAD", minTotal: 200 },
  EUROPE: { currency: "EUR", minTotal: 200 },
  AFRICA: { currency: "XOF", minTotal: 60000 },
};

/**
 * Bonus selon la région du PARRAIN (devise du parrain)
 */
const BONUSES_BY_REGION = {
  AMERICA: { currency: "CAD", parrain: 5, filleul: 3 },
  EUROPE: { currency: "EUR", parrain: 4, filleul: 2 },
  AFRICA: { currency: "XOF", parrain: 2000, filleul: 1000 },
};

function TransactionModel() {
  return Transaction;
}

/* -----------------------
 * Legacy helpers (fallback)
 * ----------------------- */

/**
 * Récupère un utilisateur depuis le service principal
 * (fallback legacy si routes internes referral pas encore en place)
 */
async function fetchUserFromMain(userId, authToken) {
  if (!PRINCIPAL_URL) return null;

  const url = `${PRINCIPAL_URL}/users/${userId}`;
  try {
    const res = await axios.get(url, { headers: buildHeaders(authToken), timeout: 8000 });
    return res.data?.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Patch user (legacy fallback)
 */
async function patchUserInMain(userId, updates, authToken) {
  if (!PRINCIPAL_URL) return;

  const url = `${PRINCIPAL_URL}/users/${userId}`;
  await axios.patch(url, updates, { headers: buildHeaders(authToken), timeout: 8000 });
}

/**
 * Créditer balance via route interne
 */
async function creditBalanceInMain(userId, amount, currency, description, authToken) {
  if (!PRINCIPAL_URL) return;
  if (!INTERNAL_TOKEN) throw new Error("INTERNAL_TOKEN manquant");

  const url = `${PRINCIPAL_URL}/users/${userId}/credit-internal`;
  await axios.post(
    url,
    { amount, currency, description },
    { headers: buildHeaders(authToken), timeout: 8000 }
  );
}

/**
 * Notification (si route ouverte)
 */
async function sendNotificationToMain(userId, title, message, data = {}, authToken) {
  if (!PRINCIPAL_URL) return;
  const url = `${PRINCIPAL_URL}/notifications`;
  try {
    await axios.post(
      url,
      { recipient: userId, title, message, data },
      { headers: buildHeaders(authToken), timeout: 8000 }
    );
  } catch (err) {
    logger.warn("[Referral] Notification failed:", err?.response?.data || err.message);
  }
}

/* -----------------------
 * Code generation (legacy fallback only)
 * ----------------------- */
function generatePNVReferralCode() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const all = letters + digits;

  const buf = crypto.randomBytes(4);
  let raw = "";
  for (let i = 0; i < 4; i++) raw += all[buf[i] % all.length];

  let arr = raw.split("");
  if (!/[0-9]/.test(raw)) arr[crypto.randomBytes(1)[0] % 4] = digits[crypto.randomBytes(1)[0] % digits.length];
  if (!/[A-Z]/.test(raw)) arr[crypto.randomBytes(1)[0] % 4] = letters[crypto.randomBytes(1)[0] % letters.length];

  return `PNV-${arr.join("")}`;
}

async function generateAndAssignReferralInMain(senderId, authToken) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const newCode = generatePNVReferralCode();
    try {
      await patchUserInMain(
        senderId,
        { referralCode: newCode, hasGeneratedReferral: true, referralCodeGeneratedAt: new Date().toISOString() },
        authToken
      );
      logger.info(`[Referral][legacy] Code "${newCode}" assigné pour ${senderId}`);
      return { ok: true, code: newCode };
    } catch (err) {
      const msg = String(err.response?.data?.error || err.response?.data?.message || err.message || "");
      if (err.response?.status === 409 || /duplicate|E11000|already exists|conflict/i.test(msg)) continue;
      throw err;
    }
  }
  throw new Error(`Impossible de générer un referralCode unique pour ${senderId}`);
}

/* -----------------------
 * TX stats (gateway)
 * ----------------------- */
async function getFirstTwoConfirmedTotal(userId) {
  const txs = await TransactionModel()
    .find({
      userId,
      status: "confirmed",
    })
    .sort({ confirmedAt: 1, createdAt: 1 })
    .limit(2)
    .lean();

  const count = Array.isArray(txs) ? txs.length : 0;
  if (count < 2) return { count, total: 0 };

  const total = txs.reduce((sum, tx) => sum + safeNumber(tx?.amount), 0);
  return { count, total };
}

/* =========================
 * ✅ 1) Code parrainage
 * =========================
 * RÈGLE: généré dès la 1ère TX confirmée.
 *
 * Cette fonction DOIT être appelée au moment où la tx devient confirmée.
 * Param optionnel `tx` pour éviter de recalculer.
 */
async function checkAndGenerateReferralCodeInMain(senderId, authToken, tx) {
  if (!senderId) return;

  // Si tx fournie, on check qu’elle est confirmée
  if (tx && !isConfirmedStatus(tx.status)) return;

  // ✅ Nouveau mode (recommandé): route interne referral
  const internal = await postInternal(
    ["/internal/referral/on-transaction-confirm", "/api/v1/internal/referral/on-transaction-confirm"],
    {
      userId: senderId,
      transaction: {
        id: String(tx?.id || tx?._id || tx?.reference || Date.now()),
        status: "confirmed",
        amount: safeNumber(tx?.amount),
        currency: tx?.currency,
        createdAt: tx?.createdAt || new Date().toISOString(),
      },
    },
    authToken
  );

  if (internal.ok) {
    logger.info(`[Referral] referralCode ensured for ${senderId}`);
    return;
  }

  // ✅ Fallback legacy: si la route interne n’existe pas encore
  try {
    const count = await TransactionModel().countDocuments({ userId: senderId, status: "confirmed" });
    if (count < 1) return;

    const userMain = await fetchUserFromMain(senderId, authToken);
    if (!userMain) return;

    if (userMain.hasGeneratedReferral || userMain.referralCode) return;

    await generateAndAssignReferralInMain(senderId, authToken);
  } catch (e) {
    logger.error("[Referral] checkAndGenerateReferralCodeInMain error:", e?.response?.data || e.message);
  }
}

/* =========================
 * ✅ 2) Bonus parrainage
 * =========================
 * RÈGLE: bonus uniquement si:
 * - filleul a referredBy (côté principal)
 * - filleul a MINIMUM 2 transactions confirmées
 * - total des 2 premières tx >= seuil selon région filleul
 * -> bonus au parrain + bonus au filleul
 */
async function processReferralBonusIfEligible(userId, authToken) {
  if (!userId) return;

  // 1) minimum 2 tx confirmées côté gateway
  const { count, total } = await getFirstTwoConfirmedTotal(userId);
  if (count < 2) return;

  // ✅ Nouveau mode (recommandé): déléguer l'idempotence + attribution au principal
  // On envoie les stats, le principal vérifiera referredBy + conditions (et ne créditera jamais 2 fois).
  const internal = await postInternal(
    ["/internal/referral/award-bonus", "/api/v1/internal/referral/award-bonus"],
    {
      refereeId: userId,
      triggerTxId: `first2_${userId}_${Date.now()}`,
      stats: {
        confirmedCount: count,
        firstTwoTotal: total,
      },
    },
    authToken
  );

  if (internal.ok) {
    logger.info(`[Referral] award-bonus requested for referee=${userId}`);
    return;
  }

  // ✅ Fallback legacy: si route interne non dispo, on garde ton ancien flow (corrigé)
  try {
    const filleul = await fetchUserFromMain(userId, authToken);
    if (!filleul) return;

    if (!filleul.referredBy) return;

    // Idempotence legacy
    if (filleul.referralBonusCredited) return;

    const parrainId = filleul.referredBy;
    const parrain = await fetchUserFromMain(parrainId, authToken);
    if (!parrain) return;

    const regionF = getRegionFromCountry(filleul.country);
    const regionP = getRegionFromCountry(parrain.country);
    if (!regionF || !regionP) return;

    const seuilCfg = THRESHOLDS_BY_REGION[regionF];
    const bonusCfg = BONUSES_BY_REGION[regionP];
    if (!seuilCfg || !bonusCfg) return;

    if (total < seuilCfg.minTotal) return;

    const { currency: bonusCurrency, parrain: bonusParrain, filleul: bonusFilleul } = bonusCfg;

    // Créditer balances
    if (bonusFilleul > 0) {
      await creditBalanceInMain(
        userId,
        bonusFilleul,
        bonusCurrency,
        "Bonus de bienvenue (filleul - programme de parrainage PayNoval)",
        authToken
      );
    }

    if (bonusParrain > 0) {
      await creditBalanceInMain(
        parrainId,
        bonusParrain,
        bonusCurrency,
        `Bonus de parrainage pour ${filleul.fullName || filleul.email || userId}`,
        authToken
      );
    }

    // Marquer crédité
    await patchUserInMain(
      userId,
      {
        referralBonusCredited: true,
        referralBonusCurrency: bonusCurrency,
        referralBonusParrainAmount: bonusParrain,
        referralBonusFilleulAmount: bonusFilleul,
        referralBonusCreditedAt: new Date().toISOString(),
      },
      authToken
    );

    // Notifications
    await sendNotificationToMain(
      parrainId,
      "Bonus parrain PayNoval crédité",
      `Vous avez reçu ${bonusParrain} ${bonusCurrency} grâce à l’activité de votre filleul.`,
      { type: "referral_bonus", role: "parrain", amount: bonusParrain, currency: bonusCurrency, childUserId: userId },
      authToken
    );

    await sendNotificationToMain(
      userId,
      "Bonus de bienvenue PayNoval crédité",
      `Vous avez reçu ${bonusFilleul} ${bonusCurrency} grâce à vos premiers transferts sur PayNoval.`,
      { type: "referral_bonus", role: "filleul", amount: bonusFilleul, currency: bonusCurrency, parentUserId: parrainId },
      authToken
    );

    logger.info(
      `[Referral][legacy] Bonus crédité (parrain=${parrainId}, filleul=${userId}, ${bonusParrain}/${bonusFilleul} ${bonusCurrency})`
    );
  } catch (err) {
    logger.error("[Referral] Erreur bonus legacy:", err?.response?.data || err.message);
  }
}

module.exports = {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
};
