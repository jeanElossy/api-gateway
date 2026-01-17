// File: src/services/exchangeRateService.js
"use strict";

const axios = require("axios");
const { LRUCache } = require("lru-cache");

const ExchangeRate = require("../models/ExchangeRate"); // ✅ gateway models/
const { normalizeCurrency } = require("../utils/currency"); // ton helper existant

/**
 * ✅ Backend principal (recommandé)
 * - PAYNOVAL_BACKEND_URL peut être avec ou sans /api/v1
 * - on normalise pour toujours appeler .../api/v1/exchange-rates/rate
 */
function normalizePrincipalBase(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (base.toLowerCase().endsWith("/api/v1")) return base;
  return base + "/api/v1";
}

const PAYNOVAL_BACKEND_URL = normalizePrincipalBase(
  process.env.PAYNOVAL_BACKEND_URL ||
    process.env.PRINCIPAL_URL ||
    "https://paynoval-backend.onrender.com"
);

/**
 * ✅ Token interne pour appeler le backend principal
 * priorité: PRINCIPAL_INTERNAL_TOKEN > GATEWAY_INTERNAL_TOKEN > INTERNAL_TOKEN
 */
const PRINCIPAL_INTERNAL_TOKEN =
  process.env.PRINCIPAL_INTERNAL_TOKEN ||
  process.env.GATEWAY_INTERNAL_TOKEN ||
  process.env.INTERNAL_TOKEN ||
  "";

/**
 * ✅ Provider externe (ultime secours)
 */
const FX_API_BASE_URL = String(
  process.env.FX_API_BASE_URL || "https://v6.exchangerate-api.com/v6"
).replace(/\/+$/, "");

const FX_API_KEY = process.env.FX_API_KEY || process.env.EXCHANGE_RATE_API_KEY || "";
const FX_CROSS = String(process.env.FX_CROSS || "USD").toUpperCase();

/**
 * Cache pair (base->quote)
 */
const FX_CACHE_TTL_MS = Number(process.env.FX_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const FX_FAIL_COOLDOWN_MS = Number(process.env.FX_FAIL_COOLDOWN_MS || 10 * 60 * 1000); // 10 min

// ✅ snapshot DB : combien de temps on accepte un taux “stale” en fallback (par défaut 24h)
const FX_DB_SNAPSHOT_MAX_AGE_MS = Number(
  process.env.FX_DB_SNAPSHOT_MAX_AGE_MS || 24 * 60 * 60 * 1000
);

const pairCache = new LRUCache({ max: 1000, ttl: FX_CACHE_TTL_MS });
// Cooldown par pair (évite spam provider / backend)
const failCache = new LRUCache({ max: 1000, ttl: FX_FAIL_COOLDOWN_MS });

console.log("[FX] exchangeRateService initialisé", {
  PAYNOVAL_BACKEND_URL,
  FX_API_BASE_URL,
  hasKey: !!FX_API_KEY,
  FX_CROSS,
  FX_CACHE_TTL_MS,
  FX_FAIL_COOLDOWN_MS,
  hasPrincipalToken: !!PRINCIPAL_INTERNAL_TOKEN,
  FX_DB_SNAPSHOT_MAX_AGE_MS,
});

function normalizeCcy(input) {
  const n = normalizeCurrency(input);
  if (!n) return "";
  return String(n).trim().toUpperCase();
}

function setCooldown(key, err, provider) {
  const status = err?.response?.status || null;
  const data = err?.response?.data || null;
  const errorType = data?.["error-type"] || data?.error || null;

  const ra = Number(err?.response?.headers?.["retry-after"]);
  const cd = Number.isFinite(ra) && ra > 0 ? ra * 1000 : FX_FAIL_COOLDOWN_MS;

  const payload = {
    provider,
    status,
    errorType,
    message: err?.message || String(err),
    retryAfterSec: Math.ceil(cd / 1000),
    nextTryAt: Date.now() + cd,
  };

  failCache.set(key, payload);
  return payload;
}

function getCooldown(key) {
  const v = failCache.get(key);
  if (!v) return null;
  if (Date.now() < v.nextTryAt) return v;
  failCache.delete(key);
  return null;
}

/**
 * ✅ Snapshot DB fallback (COMPAT modèle actuel)
 * On stocke un snapshot dans ExchangeRate avec :
 * - active:false
 * - updatedBy:"snapshot"
 *
 * ⚠️ IMPORTANT : on ne query PAS "source/provider/asOfDate" car ton schema ne les a pas.
 */
async function getSnapshotFromDb(fromCur, toCur) {
  try {
    // On privilégie le snapshot identifié
    const doc = await ExchangeRate.findOne({
      from: fromCur,
      to: toCur,
      active: false,
      updatedBy: "snapshot",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (doc) return doc;

    // fallback : n'importe quel inactif (au cas où)
    const doc2 = await ExchangeRate.findOne({
      from: fromCur,
      to: toCur,
      active: false,
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    return doc2 || null;
  } catch {
    return null;
  }
}

function isSnapshotFreshEnough(doc) {
  const ts = doc?.updatedAt || doc?.createdAt;
  if (!ts) return false;
  const age = Date.now() - new Date(ts).getTime();
  return Number.isFinite(age) && age >= 0 && age <= FX_DB_SNAPSHOT_MAX_AGE_MS;
}

async function saveSnapshotToDb(fromCur, toCur, rate) {
  try {
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) return;

    // ✅ On ne touche jamais aux custom active:true
    // ✅ On ne stocke que dans le "slot" snapshot (active:false + updatedBy:snapshot)
    await ExchangeRate.updateOne(
      { from: fromCur, to: toCur, active: false, updatedBy: "snapshot" },
      {
        $set: {
          rate: r,
          active: false,
          updatedBy: "snapshot",
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  } catch {
    // no-op
  }
}

// ✅ 1) Récupérer depuis backend principal
async function fetchFromBackendPrincipal(fromCur, toCur, { requestId } = {}) {
  if (!PAYNOVAL_BACKEND_URL) {
    throw new Error("PAYNOVAL_BACKEND_URL manquant");
  }

  const url = `${PAYNOVAL_BACKEND_URL}/exchange-rates/rate`;

  const headers = {
    Accept: "application/json",
    "User-Agent": "PayNoval-Gateway/1.0",
  };

  // ✅ IMPORTANT: token interne (sinon 401)
  if (PRINCIPAL_INTERNAL_TOKEN) {
    headers["x-internal-token"] = PRINCIPAL_INTERNAL_TOKEN;
  }

  if (requestId) headers["x-request-id"] = requestId;

  const { data } = await axios.get(url, {
    params: { from: fromCur, to: toCur },
    headers,
    timeout: 12000,
  });

  const rate = Number(data?.data?.rate ?? data?.rate);

  if (!data?.success || !Number.isFinite(rate) || rate <= 0) {
    const e = new Error("Backend principal FX: taux invalide");
    e.backendData = data;
    throw e;
  }

  return {
    rate,
    source: `backend:${data?.source || "fx"}`,
    stale: !!data?.stale,
    provider: data?.data?.provider || data?.provider,
    asOfDate: data?.data?.asOfDate || data?.asOfDate,
  };
}

// ✅ 2) Provider externe (via pivot)
async function fetchFromExternalProvider(fromCur, toCur) {
  if (!FX_API_KEY || FX_API_KEY === "REPLACE_ME") {
    throw new Error("Configuration FX manquante (FX_API_KEY).");
  }

  const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${encodeURIComponent(FX_CROSS)}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  const rates = data?.conversion_rates || null;
  if (!data || data.result !== "success" || !rates) {
    const e = new Error(data?.["error-type"] || "Provider rates missing");
    e.response = { status: 502, data };
    throw e;
  }

  const rFrom = Number(rates[fromCur]);
  const rTo = Number(rates[toCur]);

  if (!Number.isFinite(rFrom) || !Number.isFinite(rTo) || rFrom <= 0 || rTo <= 0) {
    throw new Error(`Taux introuvable via provider pour ${fromCur}→${toCur}`);
  }

  const rate = rTo / rFrom;
  return {
    rate,
    source: "external:exchangerate-api",
    stale: false,
    provider: "exchangerate-api",
  };
}

/**
 * Récupère le taux :
 * 1) same currency => 1
 * 2) taux custom admin DB (gateway) active:true
 * 3) backend principal (recommandé) (avec x-internal-token)
 * 4) provider externe (secours)
 * 5) si quota/429 => fallback snapshot DB (stale) au lieu de 503
 */
async function getExchangeRate(from, to, opts = {}) {
  console.log("[FX] getExchangeRate() called with raw values =", { from, to });

  if (!from || !to) {
    console.warn("[FX] from/to manquant, retour 1");
    return { rate: 1, source: "missing", stale: false };
  }

  const fromCur = normalizeCcy(from);
  const toCur = normalizeCcy(to);

  console.log("[FX] normalized currencies =", { fromCur, toCur });

  if (!fromCur || !toCur) {
    console.warn("[FX] devise vide après normalisation, retour 1");
    return { rate: 1, source: "invalid", stale: false };
  }

  if (fromCur === toCur) {
    return { rate: 1, source: "same", stale: false };
  }

  const pairKey = `${fromCur}_${toCur}`;

  // cache pair
  const cached = pairCache.get(pairKey);
  if (cached) return cached;

  // cooldown pair
  const blocked = getCooldown(pairKey);
  if (blocked) {
    // ✅ si cooldown, tente snapshot DB avant de throw
    const snap = await getSnapshotFromDb(fromCur, toCur);
    if (snap && typeof snap.rate === "number" && snap.rate > 0 && isSnapshotFreshEnough(snap)) {
      const out = {
        rate: Number(snap.rate),
        source: "db-snapshot",
        stale: true,
        warning: "fx_provider_cooldown_fallback",
        retryAfterSec: blocked.retryAfterSec,
        nextTryAt: blocked.nextTryAt,
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const e = new Error(`FX cooldown (${blocked.retryAfterSec}s)`);
    e.status = 503;
    e.cooldown = blocked;
    throw e;
  }

  // 1️⃣ taux custom admin (DB gateway)
  console.log("[FX] Searching custom admin rate in DB...", { from: fromCur, to: toCur });

  const found = await ExchangeRate.findOne({
    from: fromCur,
    to: toCur,
    active: true,
  }).lean();

  if (found && typeof found.rate === "number" && found.rate > 0) {
    const out = {
      rate: Number(found.rate),
      source: "db-custom",
      stale: false,
      id: String(found._id),
    };
    pairCache.set(pairKey, out);
    return out;
  }

  // 2️⃣ backend principal (prioritaire)
  try {
    const out = await fetchFromBackendPrincipal(fromCur, toCur, { requestId: opts.requestId });
    pairCache.set(pairKey, out);

    // ✅ snapshot DB utilisable si quota externe plus tard
    await saveSnapshotToDb(fromCur, toCur, out.rate);

    return out;
  } catch (err) {
    console.warn("[FX] backend principal failed, fallback provider", err?.message || String(err));
  }

  // 3️⃣ provider externe (secours)
  try {
    const out = await fetchFromExternalProvider(fromCur, toCur);
    pairCache.set(pairKey, out);

    // ✅ snapshot DB aussi
    await saveSnapshotToDb(fromCur, toCur, out.rate);

    return out;
  } catch (err) {
    const status = err?.response?.status;
    const errorType = err?.response?.data?.["error-type"];

    // ✅ si quota => cooldown + fallback snapshot DB au lieu de 503
    if (status === 429 || errorType === "quota-reached") {
      const cd = setCooldown(pairKey, err, "exchangerate-api");
      console.warn("[FX] external quota -> cooldown set", cd);

      const snap = await getSnapshotFromDb(fromCur, toCur);
      if (snap && typeof snap.rate === "number" && snap.rate > 0 && isSnapshotFreshEnough(snap)) {
        const out = {
          rate: Number(snap.rate),
          source: "db-snapshot",
          stale: true,
          warning: "fx_external_quota_fallback",
          retryAfterSec: cd?.retryAfterSec,
          nextTryAt: cd?.nextTryAt,
        };
        pairCache.set(pairKey, out);
        return out;
      }
    }

    // dernier fallback: snapshot DB même si un peu ancien
    const snap2 = await getSnapshotFromDb(fromCur, toCur);
    if (snap2 && typeof snap2.rate === "number" && snap2.rate > 0) {
      const out = {
        rate: Number(snap2.rate),
        source: "db-snapshot",
        stale: true,
        warning: "fx_fallback_snapshot_used",
      };
      pairCache.set(pairKey, out);
      return out;
    }

    const e = new Error("Taux de change indisponible");
    e.status = 503;
    e.debug = {
      fromCur,
      toCur,
      providerStatus: status || null,
      providerErrorType: errorType || null,
      providerMessage: err?.message || String(err),
      cooldown: getCooldown(pairKey) || null,
    };
    throw e;
  }
}

module.exports = {
  getExchangeRate,
};
