// File: src/services/exchangeRateService.js
'use strict';

const axios = require('axios');
const { LRUCache } = require('lru-cache');

const ExchangeRate = require('../models/ExchangeRate'); // ✅ gateway models/
const { normalizeCurrency } = require('../utils/currency'); // ton helper existant

// ✅ 1) Backend principal (recommandé)
const PAYNOVAL_BACKEND_URL = (process.env.PAYNOVAL_BACKEND_URL || 'https://paynoval-backend.onrender.com')
  .replace(/\/+$/, '');

// ✅ 2) Provider externe (ultime secours)
const FX_API_BASE_URL = (process.env.FX_API_BASE_URL || 'https://v6.exchangerate-api.com/v6')
  .replace(/\/+$/, '');
const FX_API_KEY = process.env.FX_API_KEY || process.env.EXCHANGE_RATE_API_KEY || '';
const FX_CROSS = (process.env.FX_CROSS || 'USD').toUpperCase();

// Cache pair (base->quote)
const FX_CACHE_TTL_MS = Number(process.env.FX_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const FX_FAIL_COOLDOWN_MS = Number(process.env.FX_FAIL_COOLDOWN_MS || 10 * 60 * 1000); // 10 min

const pairCache = new LRUCache({ max: 1000, ttl: FX_CACHE_TTL_MS });
// Cooldown par pair (évite spam provider / backend)
const failCache = new LRUCache({ max: 1000, ttl: FX_FAIL_COOLDOWN_MS });


console.log('[FX] exchangeRateService initialisé', {
  PAYNOVAL_BACKEND_URL,
  FX_API_BASE_URL,
  hasKey: !!FX_API_KEY,
  FX_CROSS,
  FX_CACHE_TTL_MS,
  FX_FAIL_COOLDOWN_MS,
});

function normalizeCcy(input) {
  // normalizeCurrency gère déjà F CFA / symboles etc.
  const n = normalizeCurrency(input);
  if (!n) return '';
  return String(n).trim().toUpperCase();
}

function setCooldown(key, err, provider) {
  const status = err?.response?.status || null;
  const data = err?.response?.data || null;
  const errorType = data?.['error-type'] || data?.error || null;

  const ra = Number(err?.response?.headers?.['retry-after']);
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

// ✅ 1) Récupérer depuis backend principal (DB today -> stale -> cooldown)
async function fetchFromBackendPrincipal(fromCur, toCur) {
  const url = `${PAYNOVAL_BACKEND_URL}/api/v1/exchange-rates/rate?from=${encodeURIComponent(fromCur)}&to=${encodeURIComponent(toCur)}`;

  const { data } = await axios.get(url, { timeout: 12000 });

  // attendu: { success:true, data:{ rate }, source, stale }
  const rate = Number(data?.data?.rate ?? data?.rate);

  if (!data?.success || !Number.isFinite(rate) || rate <= 0) {
    const e = new Error('Backend principal FX: taux invalide');
    e.backendData = data;
    throw e;
  }

  return {
    rate,
    source: `backend:${data?.source || 'fx'}`,
    stale: !!data?.stale,
    provider: data?.data?.provider,
    asOfDate: data?.data?.asOfDate,
  };
}

// ✅ 2) Fallback provider externe (via pivot)
async function fetchFromExternalProvider(fromCur, toCur) {
  if (!FX_API_KEY || FX_API_KEY === 'REPLACE_ME') {
    throw new Error("Configuration FX manquante (FX_API_KEY).");
  }

  const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${encodeURIComponent(FX_CROSS)}`;

  const { data } = await axios.get(url, { timeout: 15000 });

  const rates = data?.conversion_rates || null;
  if (!data || data.result !== 'success' || !rates) {
    throw new Error(data?.['error-type'] || 'Provider rates missing');
  }

  const rFrom = Number(rates[fromCur]);
  const rTo = Number(rates[toCur]);

  if (!Number.isFinite(rFrom) || !Number.isFinite(rTo) || rFrom <= 0 || rTo <= 0) {
    throw new Error(`Taux introuvable via provider pour ${fromCur}→${toCur}`);
  }

  const rate = rTo / rFrom; // cross rate
  return { rate, source: 'external:exchangerate-api', stale: false };
}

/**
 * Récupère le taux :
 * 1) same currency => 1
 * 2) taux custom admin DB (gateway)
 * 3) backend principal (recommandé)
 * 4) provider externe (secours) + cooldown si quota
 */
async function getExchangeRate(from, to) {
  console.log('[FX] getExchangeRate() called with raw values =', { from, to });

  if (!from || !to) {
    console.warn('[FX] from/to manquant, retour 1');
    return { rate: 1, source: 'missing', stale: false };
  }

  const fromCur = normalizeCcy(from);
  const toCur = normalizeCcy(to);

  console.log('[FX] normalized currencies =', { fromCur, toCur });

  if (!fromCur || !toCur) {
    console.warn('[FX] devise vide après normalisation, retour 1');
    return { rate: 1, source: 'invalid', stale: false };
  }

  if (fromCur === toCur) {
    return { rate: 1, source: 'same', stale: false };
  }

  const pairKey = `${fromCur}_${toCur}`;

  // cache pair
  const cached = pairCache.get(pairKey);
  if (cached) return cached;

  // cooldown pair
  const blocked = getCooldown(pairKey);
  if (blocked) {
    const e = new Error(`FX cooldown (${blocked.retryAfterSec}s)`);
    e.status = 503;
    e.cooldown = blocked;
    throw e;
  }

  // 1️⃣ taux custom admin (DB gateway)
  console.log('[FX] Searching custom admin rate in DB...', { from: fromCur, to: toCur });

  const found = await ExchangeRate.findOne({ from: fromCur, to: toCur, active: true }).lean();
  if (found && typeof found.rate === 'number' && found.rate > 0) {
    const out = { rate: Number(found.rate), source: 'db-custom', stale: false, id: String(found._id) };
    pairCache.set(pairKey, out);
    return out;
  }

  // 2️⃣ backend principal (prioritaire)
  try {
    const out = await fetchFromBackendPrincipal(fromCur, toCur);
    pairCache.set(pairKey, out);
    return out;
  } catch (err) {
    console.warn('[FX] backend principal failed, fallback provider', err?.message);
  }

  // 3️⃣ provider externe (secours)
  try {
    const out = await fetchFromExternalProvider(fromCur, toCur);
    pairCache.set(pairKey, out);
    return out;
  } catch (err) {
    // si quota => cooldown
    const status = err?.response?.status;
    const errorType = err?.response?.data?.['error-type'];

    if (status === 429 || errorType === 'quota-reached') {
      const cd = setCooldown(pairKey, err, 'exchangerate-api');
      console.warn('[FX] external quota -> cooldown set', cd);
    }

    const e = new Error('Taux de change indisponible');
    e.status = 503; // ✅ pas 404
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
