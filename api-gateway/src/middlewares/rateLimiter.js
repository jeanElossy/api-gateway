"use strict";

/**
 * LIMITEUR DE DÉBIT — REMPLAÇANT DIRECT D'`express-rate-limit`
 * =============================================================================
 *
 * ═══ POURQUOI UN ENVELOPPEUR PLUTÔT QUE 35 MODIFICATIONS ═════════════════
 *
 * Trente-cinq fichiers appellent `rateLimit({...})`. Brancher Redis en les
 * modifiant un à un demanderait d'ajouter partout un `store` ET un préfixe
 * distinct — et il suffirait d'en oublier un pour qu'un limiteur reste local au
 * processus, donc inopérant à plusieurs instances, sans que rien ne le signale.
 *
 * Ce module a exactement la même signature qu'`express-rate-limit`. La seule
 * modification par fichier est le chemin du `require`, et le magasin partagé
 * devient le défaut plutôt qu'une case à cocher.
 *
 * Trois choses sont ajoutées :
 *
 *   1. le magasin Redis partagé, quand `REDIS_URL` existe ;
 *   2. un **préfixe distinct par limiteur**, dérivé du site d'appel — sans
 *      quoi tous les limiteurs partageraient un compteur (voir
 *      `services/rateLimitStore.js`) ;
 *   3. `passOnStoreError: true` — une panne Redis laisse passer au lieu de
 *      renvoyer 500. La limitation protège d'un abus ; elle ne doit pas
 *      pouvoir arrêter les paiements.
 *
 * ═══ USAGE ════════════════════════════════════════════════════════════════
 *
 *     const rateLimit = require("../middleware/rateLimiter");
 *
 *     const loginLimiter = rateLimit({
 *       name: "auth-login",     // ← facultatif mais recommandé : compartiment stable
 *       windowMs: 15 * 60 * 1000,
 *       max: 5,
 *     });
 *
 * Sans `name`, le compartiment est nommé d'après le fichier et la ligne. C'est
 * stable tant que la ligne ne bouge pas ; un `name` explicite l'est toujours.
 *
 * Passer son propre `store` désactive tout ce qui précède : l'appelant reprend
 * la main entièrement.
 */

const rateLimit = require("express-rate-limit");
const { makeStore } = require("../services/rateLimitStore");

function limiter(options = {}) {
  const { name, ...rest } = options;

  // Magasin fourni explicitement : on ne s'en mêle pas.
  if (rest.store) return rateLimit(rest);

  const store = makeStore({
    name,
    stack: new Error().stack,
    owner: name || undefined,
  });

  return rateLimit({
    /**
     * Placé AVANT `...rest` : un appelant qui veut échouer fermé peut encore
     * passer `passOnStoreError: false`.
     */
    passOnStoreError: true,
    ...rest,
    ...(store ? { store } : {}),
  });
}

module.exports = limiter;

// Compatibilité avec toutes les formes d'import rencontrées dans le dépôt.
module.exports.rateLimit = limiter;
module.exports.default = limiter;
module.exports.MemoryStore = rateLimit.MemoryStore;
