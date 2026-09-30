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

/**
 * Read-your-own-writes: after a transfer, a confirmation or a cancellation, the
 * user's cached list pages are dropped so the next read shows the movement
 * instead of an up-to-8-seconds-old page. Per process: another gateway instance
 * may still serve its own copy until its TTL (bounded, documented).
 */
function invalidateUserListCache(userId) {
  const prefix = `u:${String(userId || "")}|`;
  if (prefix === "u:|") return 0;

  let removed = 0;
  for (const cache of [listTxCache, listTxInflight]) {
    for (const key of [...cache.keys()]) {
      if (String(key).startsWith(prefix)) {
        cache.delete(key);
        removed += 1;
      }
    }
  }
  return removed;
}

module.exports = {
  invalidateUserListCache,
  LIST_TX_CACHE_TTL_MS,
  LIST_TX_CACHE_MAX,
  listTxCache,
  listTxInflight,
  stableQueryString,
  buildListTxCacheKey,
};