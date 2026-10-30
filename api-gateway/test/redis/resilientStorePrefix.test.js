"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createResilientStore } = require("../../src/services/resilientStore");

test("le magasin résilient expose le préfixe de son magasin Redis", () => {
  const primary = { prefix: "rl:gw-public:", increment: async () => ({ totalHits: 1 }) };
  const store = createResilientStore({ primary, fallback: { increment: async () => ({ totalHits: 1 }) } });
  assert.equal(store.prefix, "rl:gw-public:");
});
