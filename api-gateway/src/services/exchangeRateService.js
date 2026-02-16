"use strict";

const axios = require("axios");
const { LRUCache } = require("lru-cache");

const ExchangeRate = require("../models/ExchangeRate");
const { normalizeCurrency } = require("../utils/currency");

// ─────────────────────────────────────────────
// Principal URL normalization
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Internal token normalization
// ─────────────────────────────────────────────
const PRINCIPAL_INTERNAL_TOKEN = String(
  process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    ""
).trim();

/**
 * PRINCIPAL_AUTH_MODE:
 * - "internal" (default): envoie seulement x-internal-token
 * - "bearer": envoie seulement Authorization: Bearer
 * - "both": envoie les deux
 */
const PRINCIPAL_AUTH_MODE = String(process.env.PRINCIPAL_AUTH_MODE || "internal")
  .trim()
  .toLowerCase();

// ─────────────────────────────────────────────
// External provider config
// ─────────────────────────────────────────────
const FX_API_BASE_URL = String(
  process.env.FX_API_BASE_URL || "https://v6.exchangerate-api.com/v6"
).replace(/\/+$/, "");
const FX_API_KEY = String(process.env.FX_API_KEY || process.env.EXCHANGE_RATE_API_KEY || "").trim();
const FX_CROSS = String(process.env.FX_CROSS || "USD").toUpperCase();

const FX_CACHE_TTL_MS = Number(process.env.FX_CACHE_TTL_MS || 10 * 60 * 1000);
const FX_FAIL_COOLDOWN_MS = Number(process.env.FX_FAIL_COOLDOWN_MS || 10 * 60 * 1000);
const FX_DB_SNAPSHOT_MAX_AGE_MS = Number(process.env.FX_DB_SNAPSHOT_MAX_AGE_MS || 24 * 60 * 60 * 1000);

// Optional peg fallback (XOF/EUR)
const PEG_XOF_PER_EUR = Number(process.env.PEG_XOF_PER_EUR || 655.957);

const pairCache = new LRUCache({ max: 1000, ttl: FX_CACHE_TTL_MS });
const failCache = new LRUCache({ max: 1000, ttl: FX_FAIL_COOLDOWN_MS });

console.log("[FX] exchangeRateService initialisé", {
  PAYNOVAL_BACKEND_URL,
  FX_API_BASE_URL,
  hasKey: !!FX_API_KEY,
  FX_CROSS,
  FX_CACHE_TTL_MS,
  FX_FAIL_COOLDOWN_MS,
  hasPrincipalToken: !!PRINCIPAL_INTERNAL_TOKEN,
  principalTokenLen: PRINCIPAL_INTERNAL_TOKEN.length,
  FX_DB_SNAPSHOT_MAX_AGE_MS,
  PRINCIPAL_AUTH_MODE,
  hasPeg: Number.isFinite(PEG_XOF_PER_EUR) && PEG_XOF_PER_EUR > 0,
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

// ─────────────────────────────────────────────
// Snapshot DB fallback
// ─────────────────────────────────────────────
async function getSnapshotFromDb(fromCur, toCur) {
  try {
    const doc = await ExchangeRate.findOne({
      from: fromCur,
      to: toCur,
      active: false,
      updatedBy: "snapshot",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (doc) return doc;

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

// ─────────────────────────────────────────────
// Peg fallback (XOF/EUR)
// ─────────────────────────────────────────────
function pegRate(fromCur, toCur) {
  if (!Number.isFinite(PEG_XOF_PER_EUR) || PEG_XOF_PER_EUR <= 0) return null;
  if (fromCur === "XOF" && toCur === "EUR") return 1 / PEG_XOF_PER_EUR;
  if (fromCur === "EUR" && toCur === "XOF") return PEG_XOF_PER_EUR;
  return null;
}

// ─────────────────────────────────────────────
// Anti loop guard (principal == gateway)
// ─────────────────────────────────────────────
function tryGetHost(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return "";
  }
}

function isProbablyLoopToSelf() {
  const principalHost = tryGetHost(PAYNOVAL_BACKEND_URL);
  const gatewayHost = tryGetHost(process.env.PUBLIC_BASE_URL || process.env.GATEWAY_PUBLIC_URL || "");
  if (!principalHost || !gatewayHost) return false;
  return principalHost === gatewayHost;
}

// ─────────────────────────────────────────────
// 1) Fetch from backend principal
// ─────────────────────────────────────────────
async function fetchFromBackendPrincipal(fromCur, toCur, { requestId } = {}) {
  if (!PAYNOVAL_BACKEND_URL) {
    throw new Error("PAYNOVAL_BACKEND_URL manquant");
  }

  // anti-boucle si tu as mis une URL du gateway par erreur
  if (isProbablyLoopToSelf()) {
    const e = new Error("Loop guard: PAYNOVAL_BACKEND_URL semble pointer vers le gateway");
    e.status = 500;
    throw e;
  }

  const url = `${PAYNOVAL_BACKEND_URL}/exchange-rates/rate`;

  const headers = {
    Accept: "application/json",
    "User-Agent": "PayNoval-Gateway/1.0",
  };

  if (PRINCIPAL_INTERNAL_TOKEN) {
    if (PRINCIPAL_AUTH_MODE === "both" || PRINCIPAL_AUTH_MODE === "internal") {
      headers["x-internal-token"] = PRINCIPAL_INTERNAL_TOKEN;
    }
    if (PRINCIPAL_AUTH_MODE === "both" || PRINCIPAL_AUTH_MODE === "bearer") {
      headers["Authorization"] = `Bearer ${PRINCIPAL_INTERNAL_TOKEN}`;
    }
  }

  if (requestId) headers["x-request-id"] = requestId;

  const resp = await axios.get(url, {
    params: { from: fromCur, to: toCur },
    headers,
    timeout: 12000,
    validateStatus: () => true, // on gère status nous-mêmes
  });

  const status = resp.status;
  const data = resp.data;

  // si principal renvoie html / string
  const isJsonLike = data && typeof data === "object";

  // 401/403 => auth KO (on fallback)
  if (status === 401 || status === 403) {
    const e = new Error("Backend principal FX: unauthorized");
    e.status = status;
    e.backendData = isJsonLike ? data : { raw: String(data).slice(0, 200) };
    throw e;
  }

  // 404 ou 5xx => fallback
  if (status === 404 || status >= 500) {
    const e = new Error(`Backend principal FX: http_${status}`);
    e.status = status;
    e.backendData = isJsonLike ? data : { raw: String(data).slice(0, 200) };
    throw e;
  }

  // erreurs applicatives
  if (isJsonLike && data?.success === false && (data?.error || data?.message)) {
    const e = new Error(String(data.error || data.message));
    e.status = 502;
    e.backendData = data;
    throw e;
  }

  // récup rate (root ou data.rate)
  const rate = Number((isJsonLike ? (data?.data?.rate ?? data?.rate) : null));

  if (!Number.isFinite(rate) || rate <= 0) {
    const e = new Error("Backend principal FX: taux invalide");
    e.status = 502;
    e.backendData = isJsonLike ? data : { raw: String(data).slice(0, 200) };
    throw e;
  }

  return {
    rate,
    source: `backend:${(isJsonLike ? (data?.data?.source || data?.source) : null) || "fx"}`,
    stale: !!(isJsonLike ? (data?.data?.stale ?? data?.stale) : false),
    provider: isJsonLike ? (data?.data?.provider || data?.provider) : undefined,
    asOfDate: isJsonLike ? (data?.data?.asOfDate || data?.asOfDate) : undefined,
  };
}

// ─────────────────────────────────────────────
// 2) Fetch from external provider (pivot)
// ─────────────────────────────────────────────
async function fetchFromExternalProvider(fromCur, toCur) {
  const computeFromRates = (rates, providerName) => {
    const rFrom = Number(rates?.[fromCur]);
    const rTo = Number(rates?.[toCur]);
    if (!Number.isFinite(rFrom) || !Number.isFinite(rTo) || rFrom <= 0 || rTo <= 0) {
      throw new Error(`Taux introuvable via ${providerName} pour ${fromCur}→${toCur}`);
    }
    return {
      rate: rTo / rFrom,
      source: `external:${providerName}`,
      stale: false,
      provider: providerName,
    };
  };

  // A) exchangerate-api (clé)
  if (FX_API_KEY && FX_API_KEY !== "REPLACE_ME") {
    const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${encodeURIComponent(FX_CROSS)}`;
    try {
      const { data } = await axios.get(url, { timeout: 15000 });
      const rates = data?.conversion_rates || null;
      if (!data || data.result !== "success" || !rates) {
        const e = new Error(data?.["error-type"] || "Provider rates missing");
        e.response = { status: 502, data };
        throw e;
      }
      return computeFromRates(rates, "exchangerate-api");
    } catch (err) {
      const status = err?.response?.status;
      const errorType = err?.response?.data?.["error-type"];
      // si quota, on tombe sur fallback
      if (!(status === 429 || errorType === "quota-reached")) {
        // autres erreurs: on tente fallback aussi
      }
    }
  }

  // B) open.er-api (sans clé)
  const fallbackUrl = `https://open.er-api.com/v6/latest/${encodeURIComponent(FX_CROSS)}`;
  const { data: data2 } = await axios.get(fallbackUrl, { timeout: 15000 });
  const rates2 = data2?.conversion_rates || data2?.rates || null;

  if (!rates2 || typeof rates2 !== "object") {
    const e = new Error("Fallback provider rates missing");
    e.response = { status: 502, data: data2 };
    throw e;
  }

  return computeFromRates(rates2, "open.er-api");
}

// ─────────────────────────────────────────────
// Public API: getExchangeRate
// ─────────────────────────────────────────────
async function getExchangeRate(from, to, opts = {}) {
  if (!from || !to) return { rate: 1, source: "missing", stale: false };

  const fromCur = normalizeCcy(from);
  const toCur = normalizeCcy(to);

  if (!fromCur || !toCur) return { rate: 1, source: "invalid", stale: false };
  if (fromCur === toCur) return { rate: 1, source: "same", stale: false };

  const pairKey = `${fromCur}_${toCur}`;

  // cache pair
  const cached = pairCache.get(pairKey);
  if (cached) return cached;

  // 0) peg XOF/EUR (si dispo) — utile pour ne pas casser les tests
  const peg = pegRate(fromCur, toCur);
  // (on ne retourne pas immédiatement: on le garde comme dernier recours)

  // cooldown pair
  const blocked = getCooldown(pairKey);
  if (blocked) {
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

    if (Number.isFinite(peg) && peg > 0) {
      const out = { rate: peg, source: "peg-xof-eur", stale: true, warning: "fx_cooldown_peg_fallback" };
      pairCache.set(pairKey, out);
      return out;
    }

    const e = new Error(`FX cooldown (${blocked.retryAfterSec}s)`);
    e.status = 503;
    e.cooldown = blocked;
    throw e;
  }

  // 1) custom admin rate in DB (active:true)
  const found = await ExchangeRate.findOne({ from: fromCur, to: toCur, active: true }).lean();
  if (found && typeof found.rate === "number" && found.rate > 0) {
    const out = { rate: Number(found.rate), source: "db-custom", stale: false, id: String(found._id) };
    pairCache.set(pairKey, out);
    return out;
  }

  // 2) backend principal (priority)
  try {
    const out = await fetchFromBackendPrincipal(fromCur, toCur, { requestId: opts.requestId });
    pairCache.set(pairKey, out);
    await saveSnapshotToDb(fromCur, toCur, out.rate);
    return out;
  } catch (err) {
    console.warn("[FX] backend principal failed, fallback provider", err?.message || String(err));
  }

  // 3) external provider (fallback)
  try {
    const out = await fetchFromExternalProvider(fromCur, toCur);
    pairCache.set(pairKey, out);
    await saveSnapshotToDb(fromCur, toCur, out.rate);
    return out;
  } catch (err) {
    const status = err?.response?.status;
    const errorType = err?.response?.data?.["error-type"];

    if (status === 429 || errorType === "quota-reached") {
      const cd = setCooldown(pairKey, err, "exchangerate-api");

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

    if (Number.isFinite(peg) && peg > 0) {
      const out = { rate: peg, source: "peg-xof-eur", stale: true, warning: "fx_provider_down_peg_fallback" };
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

module.exports = { getExchangeRate };
