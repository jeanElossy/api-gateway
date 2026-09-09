"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const client = require("prom-client");

const {
  createPoolTracker,
  registerMongoPoolMetrics,
  trackPool,
  listTrackers,
  resetPoolRegistry,
  POOL_EVENTS,
} = require("../src/services/mongoPoolMetrics");

const { createMetrics } = require("../src/services/metrics");

/**
 * ============================================================================
 * §41 — SATURATION DU POOL DE CONNEXIONS MONGODB
 * ============================================================================
 *
 * ⚠️ AUCUNE CONNEXION MONGO N'EST OUVERTE ICI. Le `MongoClient` est remplacé par
 * un `EventEmitter` nu : le module ne consomme que des événements CMAP, donc il
 * se teste intégralement sans base. C'est ce qui garde la suite sous les cinq
 * secondes.
 *
 * ⚠️ CE FICHIER N'EXISTE PAS DANS `api-paynoval`, qui a livré le module sans
 * test. La jauge la plus importante des cinq (`mongodb_pool_pending_checkouts`)
 * y est donc non protégée : voir le rapport de la tâche A5.a.
 */

function make() {
  return createMetrics({
    client,
    registry: new client.Registry(),
    collectDefault: false,
  });
}

function fakeLogger() {
  const lines = { warn: [], info: [] };
  return {
    lines,
    warn: (m) => lines.warn.push(String(m)),
    info: (m) => lines.info.push(String(m)),
  };
}

/* ─────────────────────────── Le compteur, pur ────────────────────────────── */

/**
 * LE test de cette tâche.
 *
 * `pending` = sorties commencées − abouties − échouées : les demandes qui
 * ATTENDENT une connexion libre. C'est le seul signal qui sépare « la base est
 * lente » de « je n'ai pas de connexion » — deux causes qui produisent la même
 * latence vue du client et appellent des correctifs opposés (campagne du
 * 2026-08-28, `BENCHMARKS.md` §8.4).
 *
 * Ce test tombe si l'on retire la jauge, ou si on la recalcule à partir de la
 * seule taille du pool.
 */
test("pending compte les demandes qui attendent une connexion libre", () => {
  const t = createPoolTracker({ name: "gateway" });

  t.record(POOL_EVENTS.POOL_CREATED, { options: { maxPoolSize: 10, minPoolSize: 0 } });

  // Dix connexions ouvertes, dix empruntées : le pool est plein.
  for (let i = 0; i < 10; i += 1) {
    t.record(POOL_EVENTS.CREATED);
    t.record(POOL_EVENTS.CHECK_OUT_STARTED);
    t.record(POOL_EVENTS.CHECKED_OUT);
  }

  assert.equal(t.snapshot().pending, 0);
  assert.equal(t.snapshot().available, 0);

  // Trois demandes de plus : elles ne peuvent qu'attendre.
  t.record(POOL_EVENTS.CHECK_OUT_STARTED);
  t.record(POOL_EVENTS.CHECK_OUT_STARTED);
  t.record(POOL_EVENTS.CHECK_OUT_STARTED);

  assert.equal(t.snapshot().pending, 3);

  // Une connexion rendue, une attente servie.
  t.record(POOL_EVENTS.CHECKED_IN);
  t.record(POOL_EVENTS.CHECKED_OUT);

  assert.equal(t.snapshot().pending, 2);

  // Une attente qui expire n'attend plus : elle a échoué.
  t.record(POOL_EVENTS.CHECK_OUT_FAILED, { reason: "timeout" });

  assert.equal(t.snapshot().pending, 1);
  assert.deepEqual(t.snapshot().checkOutFailuresByReason, { timeout: 1 });
});

test("size, checkedOut et available se déduisent des événements", () => {
  const t = createPoolTracker({ name: "users" });

  for (let i = 0; i < 5; i += 1) t.record(POOL_EVENTS.CREATED);

  t.record(POOL_EVENTS.CHECK_OUT_STARTED);
  t.record(POOL_EVENTS.CHECKED_OUT);
  t.record(POOL_EVENTS.CHECK_OUT_STARTED);
  t.record(POOL_EVENTS.CHECKED_OUT);

  const s = t.snapshot();

  assert.equal(s.size, 5);
  assert.equal(s.checkedOut, 2);
  assert.equal(s.available, 3);
});

/**
 * Le pilote peut fermer une connexion EMPRUNTÉE pendant une purge de pool. Le
 * décompte deviendrait négatif, et une jauge négative se lit comme un défaut de
 * mesure alors que l'information utile (le pool a été purgé) est portée par
 * `mongodb_pool_clears`.
 */
test("aucune valeur instantanée ne devient négative après une purge", () => {
  const t = createPoolTracker({ name: "gateway" });

  t.record(POOL_EVENTS.CREATED);
  t.record(POOL_EVENTS.CHECK_OUT_STARTED);
  t.record(POOL_EVENTS.CHECKED_OUT);

  t.record(POOL_EVENTS.POOL_CLEARED);
  t.record(POOL_EVENTS.CLOSED, { reason: "stale" });
  t.record(POOL_EVENTS.CHECKED_IN);
  t.record(POOL_EVENTS.CHECKED_IN);

  const s = t.snapshot();

  assert.equal(s.size, 0);
  assert.equal(s.checkedOut, 0);
  assert.equal(s.available, 0);
  assert.equal(s.pending, 0);
  assert.equal(s.clears, 1);
});

/**
 * La taille maximale vient du PILOTE, pas de `process.env`. Une variable mal
 * orthographiée ou une option écrasée en chemin, et la lecture de
 * l'environnement mentirait exactement au moment où on cherche à comprendre.
 *
 * Ce test tombe si quelqu'un rebranche la jauge sur `MONGO_MAX_POOL_SIZE`.
 */
test("maxPoolSize vient de l'événement du pilote, pas de l'environnement", () => {
  const t = createPoolTracker({ name: "gateway" });

  const saved = process.env.MONGO_MAX_POOL_SIZE;
  process.env.MONGO_MAX_POOL_SIZE = "999";

  try {
    t.record(POOL_EVENTS.POOL_CREATED, {
      options: { maxPoolSize: 100, minPoolSize: 0 },
    });

    assert.equal(t.snapshot().maxPoolSize, 100);
    assert.equal(t.snapshot().minPoolSize, 0);
  } finally {
    if (saved === undefined) delete process.env.MONGO_MAX_POOL_SIZE;
    else process.env.MONGO_MAX_POOL_SIZE = saved;
  }
});

/**
 * CARDINALITÉ. Un motif inconnu — ou pire, une chaîne venue d'une donnée —
 * créerait une série par valeur. Tout ce qui n'est pas dans la liste blanche du
 * pilote se replie sur `other`.
 */
test("un motif inconnu est replié sur `other`, jamais publié tel quel", () => {
  const t = createPoolTracker({ name: "gateway" });

  t.record(POOL_EVENTS.CLOSED, { reason: "idle" });
  t.record(POOL_EVENTS.CLOSED, { reason: "erreur-inventée-64f1a2b3c4d5" });
  t.record(POOL_EVENTS.CLOSED, { reason: undefined });

  assert.deepEqual(t.snapshot().closedByReason, { idle: 1, other: 2 });
});

test("attach s'abonne aux événements CMAP et se détache proprement", () => {
  const emitter = new EventEmitter();
  const t = createPoolTracker({ name: "gateway" });

  const detach = t.attach(emitter);

  emitter.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});
  assert.equal(t.snapshot().pending, 1);

  detach();

  emitter.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});
  assert.equal(t.snapshot().pending, 1);
  assert.equal(emitter.listenerCount(POOL_EVENTS.CHECK_OUT_STARTED), 0);
});

/* ─────────────────────────── Registre de processus ───────────────────────── */

/**
 * RÈGLE B.6 : un démarrage silencieux qui ment est la panne la plus chère. Sans
 * `MongoClient`, on ne s'abonne à rien — et des jauges plates se lisent comme un
 * pool au repos. Il faut donc le dire, AVEC sa conséquence.
 */
test("sans MongoClient : rien n'est suivi, et le démarrage le DIT avec sa conséquence", () => {
  resetPoolRegistry();

  const logger = fakeLogger();

  assert.equal(trackPool(undefined, "gateway", { logger }), null);
  assert.equal(listTrackers().length, 0);

  assert.equal(logger.lines.warn.length, 1);
  assert.match(logger.lines.warn[0], /gateway/);
  assert.match(logger.lines.warn[0], /Conséquence/i);

  resetPoolRegistry();
});

test("deux clients distincts donnent deux pools suivis séparément", () => {
  resetPoolRegistry();

  const logger = fakeLogger();

  trackPool(new EventEmitter(), "gateway", { logger });
  trackPool(new EventEmitter(), "users", { logger });

  assert.equal(listTrackers().length, 2);

  resetPoolRegistry();
});

/**
 * Un `MongoClient` partagé par deux connexions Mongoose ne doit être abonné
 * qu'UNE fois : un second abonnement compterait chaque événement deux fois, et
 * la saturation paraîtrait double. Le second nom devient un alias.
 */
test("un client déjà suivi n'est jamais ré-abonné — le second nom devient un alias", () => {
  resetPoolRegistry();

  const logger = fakeLogger();
  const shared = new EventEmitter();

  trackPool(shared, "gateway", { logger });
  const second = trackPool(shared, "users", { logger });

  assert.equal(second.shared, true);
  assert.equal(listTrackers().length, 1);

  shared.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});

  assert.equal(listTrackers()[0].snapshot().pending, 1);
  assert.equal(listTrackers()[0].snapshot().name, "gateway+users");
  assert.match(logger.lines.info.join("\n"), /PARTAGÉ/);

  resetPoolRegistry();
});

/* ──────────────────────────── Les jauges publiées ────────────────────────── */

test("les cinq mesures demandées sont publiées, étiquetées par pool", async () => {
  resetPoolRegistry();

  const metrics = make();
  const logger = fakeLogger();

  const gateway = new EventEmitter();
  const users = new EventEmitter();

  trackPool(gateway, "gateway", { logger });
  trackPool(users, "users", { logger });

  registerMongoPoolMetrics(metrics, { logger });

  gateway.emit(POOL_EVENTS.POOL_CREATED, { options: { maxPoolSize: 100, minPoolSize: 0 } });
  users.emit(POOL_EVENTS.POOL_CREATED, { options: { maxPoolSize: 100, minPoolSize: 0 } });

  for (let i = 0; i < 4; i += 1) {
    gateway.emit(POOL_EVENTS.CREATED, {});
    gateway.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});
    gateway.emit(POOL_EVENTS.CHECKED_OUT, {});
  }

  gateway.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});
  gateway.emit(POOL_EVENTS.CHECK_OUT_STARTED, {});
  gateway.emit(POOL_EVENTS.CHECK_OUT_FAILED, { reason: "timeout" });

  const sortie = await metrics.metrics();

  // 1. taille courante
  assert.match(sortie, /^mongodb_pool_size\{pool="gateway"\} 4$/m);
  // 2. disponibles
  assert.match(sortie, /^mongodb_pool_available\{pool="gateway"\} 0$/m);
  // 3. EN ATTENTE — la mesure qui tranche
  assert.match(sortie, /^mongodb_pool_pending_checkouts\{pool="gateway"\} 1$/m);
  assert.match(sortie, /^mongodb_pool_pending_checkouts\{pool="users"\} 0$/m);
  // 4. échecs de sortie, par motif
  assert.match(
    sortie,
    /^mongodb_pool_checkout_failures\{pool="gateway",reason="timeout"\} 1$/m
  );
  // 5. plafond configuré, tel qu'appliqué par le pilote
  assert.match(sortie, /^mongodb_pool_max_size\{pool="gateway"\} 100$/m);
  assert.match(sortie, /^mongodb_pool_max_size\{pool="users"\} 100$/m);

  // Deux clients distincts dans ce dépôt : deux séries, jamais une agrégée.
  assert.ok(!/pool="gateway\+users"/.test(sortie));

  resetPoolRegistry();
});

/**
 * `reset()` avant chaque série de `set` : sans lui, un motif d'échec qui ne se
 * reproduit plus garderait sa dernière valeur pour toujours, et l'alerte
 * resterait allumée après la fin de l'incident.
 *
 * Ce test tombe si l'on retire le `gauge.reset?.()` de `collect`.
 */
test("une série disparaît de la page quand son pool n'est plus suivi", async () => {
  resetPoolRegistry();

  const metrics = make();
  const logger = fakeLogger();

  const gateway = new EventEmitter();
  trackPool(gateway, "gateway", { logger });

  registerMongoPoolMetrics(metrics, { logger });
  gateway.emit(POOL_EVENTS.CREATED, {});

  assert.match(await metrics.metrics(), /^mongodb_pool_size\{pool="gateway"\} 1$/m);

  resetPoolRegistry();

  assert.ok(!/pool="gateway"/.test(await metrics.metrics()));
});

/**
 * RÈGLE B.4 + cardinalité. L'adresse d'un nœud du cluster révélerait la
 * topologie et ferait une série par nœud. Le pilote la met dans `address` sur
 * chaque événement CMAP : le module ne doit jamais la recopier.
 */
test("aucune adresse de serveur n'apparaît sur la page", async () => {
  resetPoolRegistry();

  const metrics = make();
  const logger = fakeLogger();

  const gateway = new EventEmitter();
  trackPool(gateway, "gateway", { logger });
  registerMongoPoolMetrics(metrics, { logger });

  gateway.emit(POOL_EVENTS.POOL_CREATED, {
    address: "paynoval-shard-00-02.abcde.mongodb.net:27017",
    options: { maxPoolSize: 100 },
  });
  gateway.emit(POOL_EVENTS.CHECK_OUT_STARTED, {
    address: "paynoval-shard-00-02.abcde.mongodb.net:27017",
  });

  const sortie = await metrics.metrics();

  assert.match(sortie, /mongodb_pool_max_size/);
  assert.ok(!/mongodb\.net/.test(sortie));
  assert.ok(!/27017/.test(sortie));
  assert.ok(!/address=/.test(sortie));

  resetPoolRegistry();
});

/* ─────────────────────── Le câblage de `src/db.js` ──────────────────────── */

/**
 * ⚠️ LE PIÈGE PROPRE À LA PASSERELLE.
 *
 * `connectToUsersDB` n'attend PAS sa connexion : `createConnection` rend l'objet
 * immédiatement et se connecte en tâche de fond. `getClient()` peut donc rendre
 * `undefined` au moment de l'appel — on se serait abonné à rien, et les jauges
 * seraient restées plates, ce qui se lit comme « pool au repos ».
 *
 * Le câblage doit donc repasser sur l'événement `connected`. Ce test lit la
 * source : il tombe si le repli disparaît.
 */
test("db.js instrumente les deux pools et gère la connexion différée de `users`", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/db.js"), "utf8");

  assert.match(source, /attachPoolMetrics\(mongoose\.connection, 'gateway'\)/);
  assert.match(source, /attachPoolMetrics\(usersConnection, 'users'\)/);

  const fn = source.slice(
    source.indexOf("function attachPoolMetrics"),
    source.indexOf("async function connectToGatewayDB")
  );

  // Repli sur `connected` : indispensable pour la connexion non attendue.
  assert.match(fn, /connected/);
  // Une métrique ne doit JAMAIS empêcher une connexion à la base.
  assert.match(fn, /try\s*\{/);
  assert.match(fn, /catch/);

  // Le pool `gateway` n'est instrumenté qu'APRÈS le `await mongoose.connect`.
  assert.ok(
    source.indexOf("await mongoose.connect(uri, opts)") <
      source.indexOf("attachPoolMetrics(mongoose.connection, 'gateway')")
  );
});
