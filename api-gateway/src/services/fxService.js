"use strict";

const axios = require("axios");

const CACHE = new Map();
const TTL_MS = 30 * 1000;

function cacheKey(from, to) {
  return `${String(from).toUpperCase()}_${String(to).toUpperCase()}`;
}

/**
 * FX endpoint interne (Gateway route ouverte):
 * - par défaut: /api/v1/exchange-rates/rate?from=CAD&to=XOF
 * - override via env:
 *   FX_BASE_URL=http://localhost:4000
 *   FX_RATE_PATH=/api/v1/exchange-rates/rate
 */
async function getMarketRate(from, to) {
  const k = cacheKey(from, to);
  const now = Date.now();
  const cached = CACHE.get(k);
  if (cached && cached.exp > now) return cached.rate;

  const base = process.env.FX_BASE_URL || "http://localhost:4000";
  const path = process.env.FX_RATE_PATH || "/api/v1/exchange-rates/rate";
  const url = `${base}${path}`;

  const { data } = await axios.get(url, {
    params: { from: String(from).toUpperCase(), to: String(to).toUpperCase() },
    timeout: 6000,
    headers: { "x-internal-call": "pricingEngine" },
  });

  const rate =
    Number(data?.rate) ||
    Number(data?.data?.rate) ||
    Number(data?.result?.rate) ||
    Number(data?.value);

  if (!Number.isFinite(rate) || rate <= 0) return null;

  CACHE.set(k, { rate, exp: now + TTL_MS });
  return rate;
}

module.exports = { getMarketRate };
