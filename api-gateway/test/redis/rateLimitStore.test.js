"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStoreFactory,
  createRegistry,
  reservePrefix,
  callSiteFromStack,
  slugify,
} = require("../../src/services/rateLimitStore");

/**
 * Aucun Redis n'est démarré ici. La fabrique reçoit ses dépendances, donc ce
 * qui se teste est le NOMMAGE des compartiments — la seule chose qui, mal
 * faite, casse en production et seulement à plusieurs instances.
 */

function fakeStoreClass() {
  const built = [];
  class FakeRedisStore {
    constructor(opts) { built.push(opts); }
  }
  return { FakeRedisStore, built };
}

const fakeClient = { call: async () => 1 };

test("slugify écarte les deux-points, qui séparent les segments de clé", () => {
  assert.equal(slugify("gw:public"), "gw-public");
  assert.equal(slugify("  gw public  "), "gw-public");
});

test("le site d'appel identifie le fichier de déclaration", () => {
  const stack = [
    "Error",
    "    at makeStore (/app/src/services/rateLimitStore.js:120:5)",
    "    at limiter (/app/src/middlewares/rateLimiter.js:50:3)",
    "    at Object.<anonymous> (/app/src/app.js:432:26)",
  ].join("\n");

  // Sans argument : le filtre par défaut écarte ce module et son enveloppeur,
  // quel que soit le dossier qui les héberge (`middleware/` ou `middlewares/`).
  assert.equal(callSiteFromStack(stack), "app.432");
});

test("deux limiteurs distincts n'écrivent jamais sous le même préfixe", () => {
  const reg = createRegistry();
  const a = reservePrefix(reg, { name: "gw-global-ip" });
  const b = reservePrefix(reg, { name: "gw-user-global" });

  assert.notEqual(a.prefix, b.prefix);
});

test("une collision est désambiguïsée au lieu de fusionner les compteurs", () => {
  const reg = createRegistry();
  const a = reservePrefix(reg, { name: "same", owner: "app.js" });
  const b = reservePrefix(reg, { name: "same", owner: "rateLimit.js" });

  assert.equal(b.collided, true);
  assert.equal(b.previousOwner, "app.js");
  assert.notEqual(a.prefix, b.prefix);
});

test("sans client Redis, la fabrique rend null : la MemoryStore reste en place", () => {
  const factory = createStoreFactory();

  assert.equal(factory.enabled, false);
  assert.equal(factory.makeStore({ name: "x" }), null);
});

test("avec un client, chaque limiteur reçoit son propre préfixe", () => {
  const { FakeRedisStore, built } = fakeStoreClass();
  const factory = createStoreFactory({ client: fakeClient, RedisStore: FakeRedisStore });

  factory.makeStore({ name: "gw-global-ip" });
  factory.makeStore({ name: "gw-auth-login" });

  assert.equal(built.length, 2);
  assert.equal(built[0].prefix, "rl:gw-global-ip:");
  assert.equal(built[1].prefix, "rl:gw-auth-login:");
});

test("les neuf limiteurs de la passerelle ont des compartiments distincts", () => {
  /**
   * `globalIpLimiter` et `userLimiter` produisent tous deux une clé
   * `ip:<adresse>` pour un appelant anonyme. Sans préfixe distinct, ils
   * partageraient le même compteur dans Redis : atteindre la limite globale
   * fermerait aussi la limite par compte, et inversement.
   */
  const { FakeRedisStore, built } = fakeStoreClass();
  const factory = createStoreFactory({ client: fakeClient, RedisStore: FakeRedisStore });

  const names = [
    "gw-global-ip", "gw-auth-login", "gw-users-me", "gw-announcements",
    "gw-admin-transactions", "gw-admin-adjustments", "gw-user-global",
    "gw-public", "gw-pricing-quote",
  ];

  for (const name of names) factory.makeStore({ name });

  const prefixes = built.map((b) => b.prefix);

  assert.equal(prefixes.length, 9);
  assert.equal(new Set(prefixes).size, 9);
});

test("l'enveloppeur garde la signature d'express-rate-limit", () => {
  const rateLimit = require("../../src/middlewares/rateLimiter");
  const mw = rateLimit({ name: "gw-test-signature", windowMs: 1000, max: 5 });

  assert.equal(typeof mw, "function");
  assert.equal(mw.length, 3);
  assert.equal(typeof rateLimit.MemoryStore, "function");
});

/**
 * Résilience — ce qui a été observé en production : Redis injoignable,
 * `increment()` qui rejette à chaque requête, et express-rate-limit qui imprime
 * une trace d'appel complète **par requête**. La panne du cache devenait une
 * inondation de journaux, et surtout : plus aucune limitation du tout.
 */
class FakeMemoryStore {
  constructor() { this.hits = 0; }
  init() {}
  async increment() { this.hits += 1; return { totalHits: this.hits, resetTime: undefined }; }
  async decrement() {}
  async resetKey() {}
}

class BrokenRedisStore {
  init() {}
  async increment() { throw new Error("Stream isn't writeable"); }
  async decrement() { throw new Error("Stream isn't writeable"); }
  async resetKey() {}
}

test("le magasin enveloppé ne rejette jamais, même Redis à terre", async () => {
  const factory = createStoreFactory({
    client: fakeClient,
    RedisStore: BrokenRedisStore,
    MemoryStore: FakeMemoryStore,
    logger: { warn() {} },
  });

  const store = factory.makeStore({ name: "gw-resilient" });

  const r = await store.increment("k");
  assert.equal(r.totalHits, 1);
});

test("pendant la panne, la limitation continue en mémoire", async () => {
  const factory = createStoreFactory({
    client: fakeClient,
    RedisStore: BrokenRedisStore,
    MemoryStore: FakeMemoryStore,
    logger: { warn() {} },
  });

  const store = factory.makeStore({ name: "gw-compte" });

  assert.equal((await store.increment("k")).totalHits, 1);
  assert.equal((await store.increment("k")).totalHits, 2);
});

test("la journalisation de panne est étranglée", async () => {
  const warnings = [];
  const factory = createStoreFactory({
    client: fakeClient,
    RedisStore: BrokenRedisStore,
    MemoryStore: FakeMemoryStore,
    logger: { warn: (m) => warnings.push(m) },
  });

  const store = factory.makeStore({ name: "gw-silencieux" });
  for (let i = 0; i < 100; i += 1) await store.increment("k");

  assert.ok(warnings.length <= 1, `attendu <= 1, obtenu ${warnings.length}`);
});
