"use strict";

/**
 * Cache léger pour GET /transactions
 */

const { LRUCache } = require("lru-cache");

const LIST_TX_CACHE_TTL_MS = (() => {
  const n = Number(process.env.LIST_TX_CACHE_TTL_MS || 8000);
  return Number.isFinite(n) && n >= 1000 ? n : 8000;
})();

const LIST_TX_CACHE_MAX = (() => {
  const n = Number(process.env.LIST_TX_CACHE_MAX || 500);
  return Number.isFinite(n) && n >= 50 ? n : 500;
})();

const listTxCache = new LRUCache({
  max: LIST_TX_CACHE_MAX,
  ttl: LIST_TX_CACHE_TTL_MS,
});

const listTxInflight = new LRUCache({
  max: LIST_TX_CACHE_MAX,
  ttl: LIST_TX_CACHE_TTL_MS,
});

function stableQueryString(obj = {}) {
  try {
    const keys = Object.keys(obj || {}).sort();
    const parts = [];

    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;

      if (Array.isArray(v)) {
        for (const it of v) {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(it))}`);
        }
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }

    return parts.join("&");
  } catch {
    return "";
  }
}

function buildListTxCacheKey({ userId, provider, query }) {
  const qs = stableQueryString(query || {});
  return `u:${String(userId)}|p:${String(provider)}|q:${qs}`;
}

module.exports = {
  LIST_TX_CACHE_TTL_MS,
  LIST_TX_CACHE_MAX,
  listTxCache,
  listTxInflight,
  stableQueryString,
  buildListTxCacheKey,
};