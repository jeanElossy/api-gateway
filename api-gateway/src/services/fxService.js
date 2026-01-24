"use strict";

const axios = require("axios");

const CACHE = new Map();
const TTL_MS = 30 * 1000;

function cacheKey(from, to) {
  return `${String(from).toUpperCase()}_${String(to).toUpperCase()}`;
}

function safeUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function safeBaseUrl() {
  // En prod Render, le plus fiable pour s'appeler soi-même = loopback
  // (évite les soucis DNS/IPv6 et ne sort pas sur Internet)
  const port = Number(process.env.PORT || 4000);
  return `http://127.0.0.1:${port}`;
}

function sanitizeRatePath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "/api/v1/exchange-rates/rate";

  const path = raw.startsWith("/") ? raw : `/${raw}`;

  // 🔒 Anti-boucle / anti-mauvaise config
  // Si quelqu’un met /pricing/quote par erreur, on corrige automatiquement.
  if (/\/pricing\b/i.test(path)) {
    return "/api/v1/exchange-rates/rate";
  }

  // On accepte seulement exchange-rates/rate (ou variantes compatibles)
  if (/\/exchange-rates\/rate\b/i.test(path)) return path;

  // Fallback safe
  return "/api/v1/exchange-rates/rate";
}

/**
 * FX endpoint interne (Gateway route ouverte):
 * - défaut: /api/v1/exchange-rates/rate?from=CAD&to=XOF
 * - override via env (si besoin):
 *   FX_BASE_URL=http://127.0.0.1:4000
 *   FX_RATE_PATH=/api/v1/exchange-rates/rate
 */
async function getMarketRate(from, to) {
  const FROM = safeUpper(from);
  const TO = safeUpper(to);
  const k = cacheKey(FROM, TO);

  const now = Date.now();
  const cached = CACHE.get(k);
  if (cached && cached.exp > now) return cached.rate;

  const base = (process.env.FX_BASE_URL || "").trim() || safeBaseUrl();
  const ratePath = sanitizeRatePath(process.env.FX_RATE_PATH);

  const url = `${base.replace(/\/+$/g, "")}${ratePath}`;

  try {
    const { data } = await axios.get(url, {
      params: { from: FROM, to: TO },
      timeout: 6000,
      headers: { "x-internal-call": "pricingEngine" },
      // éviter les caches intermédiaires
      validateStatus: (s) => s >= 200 && s < 500,
    });

    // si endpoint introuvable ou réponse invalide
    if (!data) return null;

    const rate =
      Number(data?.rate) ||
      Number(data?.data?.rate) ||
      Number(data?.result?.rate) ||
      Number(data?.value);

    if (!Number.isFinite(rate) || rate <= 0) return null;

    CACHE.set(k, { rate, exp: now + TTL_MS });
    return rate;
  } catch (e) {
    // Ne pas casser le pricing si la source FX a un souci
    return null;
  }
}

module.exports = { getMarketRate };
