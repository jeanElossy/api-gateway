"use strict";

/**
 * CACHE MÉMOIRE DES RÈGLES TARIFAIRES ACTIVES
 * -----------------------------------------------------------------------------
 * /pricing/quote est ouvert sans JWT et lisait la collection entière à CHAQUE
 * devis. Le workflow de gouvernance fournit un point d'invalidation exact :
 * toute publication purge le cache. C'est la raison pour laquelle ce cache
 * arrive après la gouvernance et non avant — sans elle, il aurait fallu se
 * contenter d'un TTL aveugle.
 *
 * ⚠️ La fenêtre startsAt/endsAt N'EST PAS filtrée ici : une règle démarrant dans
 * une heure doit être en cache pour entrer en vigueur toute seule. C'est
 * `pickBestRule` qui évalue la fenêtre, à chaque devis.
 *
 * Le TTL reste un filet pour le cas multi-instances, où l'invalidation ne touche
 * que le process qui a publié.
 */

const PricingRule = require("../../models/PricingRule");

const DEFAULT_TTL_MS = Number(process.env.PRICING_RULES_CACHE_TTL_MS || 120000);

let cached = null;
let loadedAt = 0;
let inFlight = null;
let hits = 0;
let misses = 0;

/** Chargement par défaut : règles actives et non archivées. */
async function defaultLoader() {
  return PricingRule.find({ active: true, archivedAt: null }).lean();
}

/**
 * @param {{loader?: function, ttlMs?: number}} options
 * @returns {Promise<Array>}
 */
async function getActiveRules({ loader = defaultLoader, ttlMs = DEFAULT_TTL_MS } = {}) {
  const fresh = cached !== null && Date.now() - loadedAt < ttlMs;

  if (fresh) {
    hits += 1;
    return cached;
  }

  // Une seule requête en vol : dix devis simultanés sur un cache froid ne
  // doivent pas produire dix lectures de la collection.
  if (inFlight) return inFlight;

  misses += 1;

  inFlight = (async () => {
    try {
      const rules = await loader();
      cached = Array.isArray(rules) ? rules : [];
      loadedAt = Date.now();
      return cached;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Appelée après toute publication. Le prochain devis rechargera. */
function invalidateRuleCache() {
  cached = null;
  loadedAt = 0;
}

function cacheStats() {
  return {
    size: Array.isArray(cached) ? cached.length : 0,
    loadedAt: loadedAt || null,
    hits,
    misses,
  };
}

module.exports = {
  getActiveRules,
  invalidateRuleCache,
  cacheStats,
  defaultLoader,
  DEFAULT_TTL_MS,
};
