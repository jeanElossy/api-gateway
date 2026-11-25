"use strict";

/**
 * Un disjoncteur PAR OPÉRATION, et la limite d'un client n'est pas une panne
 * (2026-11-25).
 *
 * Constaté : transfert, dépôt et retrait refusés au premier essai (« Service
 * PayNoval temporairement indisponible »), acceptés au second. La clé du
 * disjoncteur était l'origine de Tx-Core : cinq lectures en échec (liste des
 * transactions, relue sans cesse par l'app) ou cinq 429 d'UN compte coupaient
 * les envois de TOUS les utilisateurs pendant 30 s. Ce test échoue si les
 * lectures et les écritures partagent de nouveau un compteur, si des familles
 * de routes se contaminent, ou si un 429 par compte de Tx-Core ouvre le
 * disjoncteur. Faux `axios`, sans serveur ni base.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";
const TX_CORE = "http://tx-core-scope.test";
process.env.PAYNOVAL_SERVICE_URL = TX_CORE;

const ROOT = path.join(__dirname, "..", "..");
const axiosPath = require.resolve("axios", { paths: [ROOT] });
require(axiosPath);
let nextResponse = null;
const fakeAxios = async () => {
  const err = new Error(`HTTP ${nextResponse.status}`);
  err.response = nextResponse;
  throw err;
};
require.cache[axiosPath].exports = fakeAxios;

const { safeAxiosRequest, breaker, circuitKeyFor, isClientQuotaRefusal } = require("../../src/services/transactions/httpClient");

async function call(method, url) {
  try {
    await safeAxiosRequest({ method, url, data: {} });
    return null;
  } catch (e) {
    return e;
  }
}

test("lecture et écriture, familles de routes : des clés distinctes", () => {
  const list = circuitKeyFor(`${TX_CORE}/api/v1/transactions?limit=25`, "get");
  const initiate = circuitKeyFor(`${TX_CORE}/api/v1/transactions/initiate`, "post");
  const webhook = circuitKeyFor(`${TX_CORE}/internal/webhooks/relay`, "post");
  assert.notEqual(list, initiate);
  assert.notEqual(initiate, webhook);
  assert.equal(initiate, `${TX_CORE}|write|transactions`);
  assert.equal(circuitKeyFor(`${TX_CORE}/api/v1/transactions/abc/confirm`, "POST"), initiate);
});

test("cinq lectures en échec n'empêchent plus un envoi d'argent", async () => {
  nextResponse = { status: 500, headers: {}, data: { success: false, error: "boom" } };
  for (let i = 0; i < 8; i += 1) await call("get", `${TX_CORE}/api/v1/transactions`);

  assert.equal(breaker.inspect(circuitKeyFor(`${TX_CORE}/api/v1/transactions`, "get")).state, "open");
  const writeKey = circuitKeyFor(`${TX_CORE}/api/v1/transactions/initiate`, "post");
  assert.equal(breaker.inspect(writeKey).state, "closed", "les lectures en échec coupaient les envois de tous les utilisateurs");

  nextResponse = { status: 400, headers: {}, data: { success: false, code: "VALIDATION" } };
  const e = await call("post", `${TX_CORE}/api/v1/transactions/initiate`);
  assert.equal(e.isProviderCooldown, false, "l'envoi a été refusé par le disjoncteur des lectures");
});

test("un 429 par compte de Tx-Core n'ouvre pas le disjoncteur", async () => {
  const url = `${TX_CORE}/api/v1/sandbox/quota-check`;
  nextResponse = { status: 429, headers: {}, data: { success: false, code: "AML_RATE_LIMIT_1H" } };
  for (let i = 0; i < 10; i += 1) await call("post", url);
  assert.equal(breaker.inspect(circuitKeyFor(url, "post")).state, "closed");
});

test("témoins : un 429 sans code, ou d'un prestataire externe, reste une panne ; un vrai 503 aussi", async () => {
  assert.equal(isClientQuotaRefusal({ url: `${TX_CORE}/x`, status: 429, data: { code: "RATE_LIMITED" } }), true);
  assert.equal(isClientQuotaRefusal({ url: `${TX_CORE}/x`, status: 429, data: "Too many" }), false);
  assert.equal(isClientQuotaRefusal({ url: "http://provider.example/x", status: 429, data: { code: "RATE" } }), false);

  const url = `${TX_CORE}/api/v1/claims/outage`;
  nextResponse = { status: 503, headers: {}, data: { success: false, error: "down" } };
  for (let i = 0; i < 10; i += 1) await call("post", url);
  assert.equal(breaker.inspect(circuitKeyFor(url, "post")).state, "open");
});
