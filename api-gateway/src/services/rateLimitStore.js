"use strict";

/**
 * MAGASIN PARTAGÉ DE LIMITATION DE DÉBIT
 * =============================================================================
 *
 * ═══ CE QUE CE MODULE DÉBLOQUE ═══════════════════════════════════════════
 *
 * Les ~35 limiteurs du backend comptaient chacun dans une `Map` locale au
 * processus. Tant qu'il n'y a qu'une instance, cela fonctionne. À deux
 * instances derrière un répartiteur, **chaque limite est doublée** : un client
 * autorisé à 5 tentatives de connexion en obtient 10, réparties au hasard. À
 * dix instances, la limite ne veut plus rien dire — et rien ne le signale, ni
 * dans les journaux, ni dans les métriques.
 *
 * C'est le dernier verrou qui empêchait d'ajouter une deuxième instance. Il
 * faut un compteur commun, donc Redis.
 *
 * ═══ UN PRÉFIXE PAR LIMITEUR, ET POURQUOI C'EST CRITIQUE ═════════════════
 *
 * En mémoire, chaque appel à `rateLimit()` crée sa propre `Map` : l'isolement
 * entre limiteurs est gratuit. Avec un magasin Redis partagé, il devient une
 * **responsabilité explicite** : deux limiteurs qui écrivent sous le même
 * préfixe partagent leurs compteurs.
 *
 * Concrètement, sans préfixe distinct, un utilisateur qui consulte son solde
 * consommerait le budget du limiteur de connexion. Les 429 apparaîtraient sur
 * des routes sans rapport, et la limite de connexion — celle qui protège
 * réellement — serait épuisée par du trafic anodin. Le tout uniquement en
 * production, uniquement à plusieurs instances : le pire profil de bogue.
 *
 * Le préfixe est donc dérivé du **site d'appel** (fichier + ligne), stable d'un
 * déploiement à l'autre puisque c'est le même code. Un `name` explicite est
 * accepté et prioritaire.
 *
 * En cas de collision on ne lève pas : on désambiguïse et on journalise. Une
 * collision produit un compartiment légèrement mal nommé ; une exception au
 * démarrage produit une panne.
 *
 * ═══ QUE FAIRE QUAND REDIS TOMBE ? PASSER. ═══════════════════════════════
 *
 * C'est le choix de Stripe et de Cloudflare, et il n'est pas évident : un
 * limiteur qui échoue peut soit **bloquer** (fail-closed, on refuse), soit
 * **laisser passer** (fail-open).
 *
 * Bloquer transformerait une panne du cache en panne totale de l'API — les
 * paiements s'arrêtent parce que le compteur de requêtes est indisponible.
 * C'est disproportionné : la limitation de débit protège d'un abus, elle n'est
 * pas une règle métier. On laisse donc passer, et on journalise.
 *
 * Deux réglages rendent ce choix réellement effectif :
 *
 *   • `passOnStoreError: true` (natif depuis express-rate-limit 7) — une erreur
 *     du magasin laisse la requête continuer au lieu de produire un 500 ;
 *
 *   • `enableOfflineQueue: false` sur le client Redis — sans cela, ioredis met
 *     les commandes **en file d'attente** pendant une coupure. La requête ne
 *     rendrait pas d'erreur : elle attendrait. Chaque appel HTTP resterait
 *     bloqué jusqu'au délai de connexion, et le fail-open ne servirait à rien.
 *
 * ═══ TLS ══════════════════════════════════════════════════════════════════
 *
 * TLS est activé sur `rediss://` uniquement, jamais imposé. Le forcer sur une
 * URL `redis://` fait échouer la poignée de main en silence — le magasin ne
 * démarre jamais et l'on retombe en mémoire sans s'en apercevoir.
 */

const DEFAULT_PREFIX_ROOT = "rl";

/**
 * Trames à ignorer pour déterminer le site d'appel : ce module et son
 * enveloppeur. Comparées au nom de base, pour être insensibles à
 * `middleware/` comme à `middlewares/`.
 */
const DEFAULT_SKIP_FILES = Object.freeze(["rateLimitStore", "rateLimiter"]);

/* -------------------------------------------------------------------------- */
/* Nommage — fonctions pures                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Réduit une chaîne à un identifiant de préfixe Redis sûr.
 *
 * Les deux-points sont réservés : ils séparent les segments de clé.
 */
function slugify(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Extrait « fichier:ligne » de la première trame utile d'une pile.
 *
 * On saute les trames internes à ce module et au middleware qui l'enveloppe :
 * ce qui nous intéresse, c'est le fichier de route qui a déclaré le limiteur.
 *
 * Fonction **pure** : elle reçoit la pile en chaîne, donc elle se teste sans
 * lever d'exception réelle.
 */
function callSiteFromStack(stack, { skipFiles = DEFAULT_SKIP_FILES } = {}) {
  const lines = String(stack || "").split("\n").slice(1);

  for (const line of lines) {
    const match = line.match(/\(?([^()\s]+):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;

    const [, file, lineNo] = match;

    if (file.includes("node_modules")) continue;

    const base = file.split(/[\\/]/).pop().replace(/\.[cm]?js$/, "");

    /**
     * On compare sur le NOM DE BASE, pas sur un fragment de chemin.
     *
     * La version précédente écartait « middleware/rateLimiter.js ». La
     * passerelle range ses intergiciels dans `middlewares/` — au pluriel : la
     * trame n'était donc pas écartée, et TOUS ses limiteurs anonymes se
     * retrouvaient nommés `rateLimiter.<ligne>`, donc dans le même
     * compartiment. Exactement le défaut que ce module existe pour empêcher.
     */
    if (skipFiles.some((f) => base === f || file.endsWith(f))) continue;

    return `${base}.${lineNo}`;
  }

  return "";
}

/** Crée un registre de préfixes. Les tests en obtiennent un neuf. */
function createRegistry() {
  return new Map();
}

/**
 * Réserve un préfixe unique.
 *
 * @returns {{ prefix: string, collided: boolean, previousOwner: string|null }}
 */
function reservePrefix(registry, { name, owner, root = DEFAULT_PREFIX_ROOT }) {
  const base = slugify(name) || "anonymous";

  let candidate = base;
  let n = 1;

  while (registry.has(candidate)) {
    n += 1;
    candidate = `${base}~${n}`;
  }

  const previousOwner = n > 1 ? registry.get(base) || null : null;

  registry.set(candidate, owner || base);

  return {
    prefix: `${root}:${candidate}:`,
    collided: n > 1,
    previousOwner,
  };
}

/* -------------------------------------------------------------------------- */
/* Fabrique — injection explicite                                             */
/* -------------------------------------------------------------------------- */

/**
 * Construit une fabrique de magasins.
 *
 * Tout ce dont elle dépend lui est **fourni** : le client Redis, la classe de
 * magasin, le registre, le journal. Un test peut donc vérifier le nommage, la
 * désambiguïsation et le repli mémoire sans qu'aucun Redis ne tourne.
 */
function createStoreFactory({
  client = null,
  RedisStore = null,
  registry = createRegistry(),
  logger = null,
  prefixRoot = DEFAULT_PREFIX_ROOT,
} = {}) {
  const enabled = Boolean(client && RedisStore);

  /**
   * @returns {object|null} Le magasin, ou `null` pour laisser
   *          express-rate-limit utiliser sa `MemoryStore`.
   */
  function makeStore({ name = "", stack = "", owner = "" } = {}) {
    const label =
      slugify(name) ||
      callSiteFromStack(stack) ||
      "anonymous";

    const { prefix, collided, previousOwner } = reservePrefix(registry, {
      name: label,
      owner: owner || label,
      root: prefixRoot,
    });

    if (collided) {
      logger?.warn?.(
        `[rate-limit] préfixe « ${label} » déjà pris (${previousOwner}) — ` +
          `désambiguïsé en « ${prefix} ». Nommez ce limiteur explicitement ` +
          `via l'option \`name\` pour obtenir un compartiment stable.`
      );
    }

    if (!enabled) return null;

    return new RedisStore({
      prefix,
      sendCommand: (...args) => client.call(...args),
    });
  }

  return {
    makeStore,
    enabled,
    registry,
    /** Pour les journaux de démarrage et le diagnostic. */
    listPrefixes: () => Array.from(registry.entries()),
  };
}

/* -------------------------------------------------------------------------- */
/* Point de composition                                                       */
/* -------------------------------------------------------------------------- */

let _factory = null;
let _client = null;

function buildClient(url, { Redis, logger }) {
  const client = new Redis(url, {
    /**
     * Sans cela, une coupure Redis met les commandes EN ATTENTE au lieu
     * d'échouer : chaque requête HTTP se bloquerait jusqu'au délai de
     * connexion, et le repli « laisser passer » ne s'appliquerait jamais.
     */
    enableOfflineQueue: false,

    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    keepAlive: 30000,

    // TLS uniquement si l'URL le demande — l'imposer casse `redis://`.
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });

  client.on("error", (err) => {
    logger?.warn?.(
      `[rate-limit] Redis indisponible — les requêtes passent sans limitation : ${
        err?.message || err
      }`
    );
  });

  client.on("ready", () => {
    logger?.info?.("[rate-limit] magasin Redis partagé actif");
  });

  return client;
}

function getFactory() {
  if (_factory) return _factory;

  const logger = safeLogger();
  const url = String(process.env.REDIS_URL || "").trim();

  if (!url) {
    logger?.warn?.(
      "[rate-limit] REDIS_URL absent — comptage EN MÉMOIRE. " +
        "Correct sur une seule instance ; à plusieurs, chaque limite est " +
        "multipliée par le nombre d'instances."
    );

    _factory = createStoreFactory({ logger });
    return _factory;
  }

  let RedisStore = null;
  let Redis = null;

  try {
    RedisStore = require("rate-limit-redis").default || require("rate-limit-redis");
    Redis = require("ioredis");
  } catch (err) {
    logger?.error?.(
      `[rate-limit] REDIS_URL défini mais modules absents (${
        err?.message || err
      }) — repli mémoire.`
    );

    _factory = createStoreFactory({ logger });
    return _factory;
  }

  _client = buildClient(url, { Redis, logger });
  _factory = createStoreFactory({ client: _client, RedisStore, logger });

  return _factory;
}

function safeLogger() {
  try {
    return require("../logger");
  } catch {
    return null;
  }
}

module.exports = {
  // Fabrique et fonctions pures — c'est ce que testent les tests.
  createStoreFactory,
  createRegistry,
  reservePrefix,
  callSiteFromStack,
  slugify,
  DEFAULT_SKIP_FILES,
  DEFAULT_PREFIX_ROOT,

  // Façade paresseuse.
  makeStore: (opts) => getFactory().makeStore(opts),
  isRedisEnabled: () => getFactory().enabled,
  listPrefixes: () => getFactory().listPrefixes(),

  /** Réservé aux tests et à l'arrêt propre. */
  __reset: () => {
    try {
      _client?.disconnect?.();
    } catch {}
    _client = null;
    _factory = null;
  },
};
