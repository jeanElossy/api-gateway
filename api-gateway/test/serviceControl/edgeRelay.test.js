"use strict";

/**
 * ============================================================================
 * SERVICE CONTROL AT THE EDGE — what the gateway must never break
 * ============================================================================
 *
 * Contract: docs/architecture/service-control.md (§2, §5, §9, §10).
 *
 * Three regressions are locked here, each one measured on 2026-10-17:
 *
 *   1. The circuit breaker counted every 503 as an outage. Five maintenance
 *      refusals from Tx-Core opened the circuit on the WHOLE Tx-Core origin —
 *      provider-webhook relay included — for 30 s to 5 min, and kept refusing
 *      after the reopening.
 *   2. `sendProxyError` rebuilt `{ message, error, details }` and dropped the
 *      machine `code`: the app could not tell a maintenance from a limit.
 *   3. The forwarded header set is rebuilt: without an explicit pick, the app
 *      version never reached Tx-Core, and a blocked version could not be
 *      refused there.
 *
 * Behaviour tests: the real modules are loaded, the network is replaced by a
 * fake `axios`. No server, no database.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const ROOT = path.resolve(__dirname, "..", "..");

/* ---------------------------------------------------------------- fake axios */

const axiosPath = require.resolve("axios", { paths: [ROOT] });
require(axiosPath);

let nextResponse = null;

function fakeAxios() {
  const r = nextResponse;

  if (r.ok) return Promise.resolve({ status: r.status, headers: r.headers || {}, data: r.data });

  const err = new Error(`Request failed with status code ${r.status}`);
  err.response = { status: r.status, headers: r.headers || {}, data: r.data };
  return Promise.reject(err);
}

require.cache[axiosPath].exports = fakeAxios;

const relay = require("../../src/services/serviceControlRelay");
const { safeAxiosRequest, breaker } = require("../../src/services/transactions/httpClient");
const { auditForwardHeaders } = require("../../src/services/transactions/phoneSecurity");

async function call(url) {
  try {
    await safeAxiosRequest({ method: "post", url, data: {} });
    return null;
  } catch (e) {
    return e;
  }
}

/* ------------------------------------------------------------ 1. breaker */

test("a deliberate refusal never opens the breaker — 20 in a row", async () => {
  const url = "http://tx-core-deliberate.test/api/v1/transactions/initiate";
  nextResponse = {
    status: 503,
    headers: { "x-paynoval-service-control": "MAINTENANCE_ACTIVE", "retry-after": "600" },
    data: { success: false, code: "MAINTENANCE_ACTIVE", message: "Maintenance" },
  };

  for (let i = 0; i < 20; i += 1) {
    const e = await call(url);
    assert.equal(e.isServiceControl, true);
    assert.equal(e.isProviderCooldown, false);
  }

  assert.equal(
    breaker.inspect("http://tx-core-deliberate.test").state,
    "closed",
    "Maintenance refusals opened the circuit: webhooks relayed through the same origin would be refused."
  );
});

test("a real 503 (no service-control header) still opens the breaker", async () => {
  const url = "http://tx-core-outage.test/api/v1/transactions/initiate";
  nextResponse = { status: 503, headers: {}, data: { success: false, error: "down" } };

  for (let i = 0; i < 10; i += 1) await call(url);

  assert.equal(breaker.inspect("http://tx-core-outage.test").state, "open");
});

test("a forged / unknown service-control value is NOT treated as deliberate", () => {
  assert.equal(
    relay.isDeliberateRefusal({ headers: { "x-paynoval-service-control": "WHATEVER" } }),
    false
  );
  assert.equal(relay.isDeliberateRefusal({ headers: {} }), false);
  for (const code of relay.SERVICE_CONTROL_CODES) {
    assert.equal(relay.isDeliberateRefusal({ headers: { "X-PayNoval-Service-Control": code } }), true);
  }
});

/* ------------------------------------------------------- 2. code relayed */

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function loadControllerWith(errorToThrow) {
  const orchestratorPath = require.resolve("../../src/services/transactions/orchestrator");
  const controllerPath = require.resolve("../../controllers/transactionsController");

  require(orchestratorPath);
  const original = require.cache[orchestratorPath].exports;

  require.cache[orchestratorPath].exports = {
    ...original,
    initiateTransactionOrThrow: async () => { throw errorToThrow; },
    forwardSimpleActionOrThrow: async () => { throw errorToThrow; },
  };

  delete require.cache[controllerPath];
  const ctrl = require(controllerPath);
  require.cache[orchestratorPath].exports = original;
  return ctrl;
}

test("initiate: the engine refusal reaches the client WITH its code, headers and details", async () => {
  const err = new Error("Request failed");
  err.status = 503;
  err.response = {
    status: 503,
    headers: { "x-paynoval-service-control": "FEATURE_UNAVAILABLE", "retry-after": "1800" },
    data: {
      success: false,
      code: "FEATURE_UNAVAILABLE",
      message: "Les retraits sont temporairement indisponibles.",
      serviceControl: { level: "MAINTENANCE", scope: "feature", key: "money.withdraw", retryAfterSec: 1800 },
      requestId: "req-1",
      stack: "Error: at /srv/tx-core/secret.js:12",
    },
  };

  const ctrl = loadControllerWith(err);
  const res = fakeRes();
  await ctrl.initiateTransaction({ body: {}, headers: {}, user: { _id: "u1" } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "FEATURE_UNAVAILABLE", "the machine code was dropped at the edge");
  assert.equal(res.body.serviceControl.key, "money.withdraw");
  assert.equal(res.body.error, "Les retraits sont temporairement indisponibles.");
  assert.equal(res.body.stack, undefined, "an engine stack trace leaked to the client");
  assert.equal(res.headers["Retry-After"], "1800");
  assert.equal(res.headers["X-PayNoval-Service-Control"], "FEATURE_UNAVAILABLE");
});

test("initiate: a limit refusal keeps its code too (was dropped before 2026-10-17)", async () => {
  const err = new Error("Request failed");
  err.status = 403;
  err.response = {
    status: 403,
    headers: {},
    data: { success: false, code: "LIMIT_ROLLING_24H", error: "Plafond atteint", remaining: 0 },
  };

  const ctrl = loadControllerWith(err);
  const res = fakeRes();
  await ctrl.initiateTransaction({ body: {}, headers: {}, user: { _id: "u1" } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "LIMIT_ROLLING_24H");
  assert.equal(res.body.remaining, 0);
  assert.equal(res.body.message, "Plafond atteint");
  assert.equal(res.headers["X-PayNoval-Service-Control"], undefined);
});

/* ------------------------------------------------- 3. identity headers */

test("the app identity headers are forwarded to Tx-Core, validated", () => {
  const headers = auditForwardHeaders({
    headers: {
      "X-App-Version": "1.4.2",
      "x-app-platform": "IOS",
      "x-app-build": "42",
      "x-app-update-id": "0f8c2a3e-1b2c-4d5e-8f90-123456789abc",
      "x-app-runtime-version": "1.4.0",
    },
    user: { _id: "u1" },
  });

  assert.equal(headers["x-app-version"], "1.4.2");
  assert.equal(headers["x-app-platform"], "ios");
  assert.equal(headers["x-app-build"], "42");
  assert.equal(headers["x-app-update-id"], "0f8c2a3e-1b2c-4d5e-8f90-123456789abc");
  assert.equal(headers["x-app-runtime-version"], "1.4.0");
});

test("an invalid identity value is dropped, never rewritten", () => {
  const out = relay.pickAppIdentityHeaders({
    headers: {
      "x-app-version": "1.0.0<script>",
      "x-app-platform": "windows",
      "x-app-update-id": "not an id",
    },
  });

  assert.deepEqual(out, {});
});

/* ----------------------------------------------- 4. public status routes */

test("the two public status routes are open in EXACT, proxied, and rate limited", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const openExact = src.slice(src.indexOf("const OPEN_EXACT = ["), src.indexOf("const OPEN_PREFIX = ["));
  const openPrefix = src.slice(src.indexOf("const OPEN_PREFIX = ["), src.indexOf("const openEndpoints"));
  const principal = src.slice(src.indexOf("const PRINCIPAL_PREFIXES = ["), src.indexOf("function makePrincipalProxy"));

  for (const p of ["/api/v1/app/status", "/api/v1/status/public"]) {
    assert.ok(openExact.includes(`"${p}"`), `${p} must be in OPEN_EXACT`);
    assert.ok(src.includes(`app.use("${p}", serviceStatusLimiter)`), `${p} must be rate limited`);
  }

  assert.ok(!openPrefix.includes('"/api/v1/app"'), "never open the whole /api/v1/app prefix");
  assert.ok(!openPrefix.includes('"/api/v1/status"'), "never open the whole /api/v1/status prefix");
  assert.ok(principal.includes('"/api/v1/app"') && principal.includes('"/api/v1/status"'));
  assert.ok(src.includes('"X-PayNoval-Service-Control"'), "the header must be exposed to the browser (CORS)");
});

test("status-page e-mail subscription routes are open in EXACT and rate limited", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const openExact = src.slice(src.indexOf("const OPEN_EXACT = ["), src.indexOf("const OPEN_PREFIX = ["));

  for (const p of ["/api/v1/status/subscribe", "/api/v1/status/subscribe/confirm", "/api/v1/status/unsubscribe"]) {
    assert.ok(openExact.includes(`"${p}"`), `${p} must be in OPEN_EXACT`);
  }
  assert.ok(src.includes('app.use("/api/v1/status/subscribe", statusSubscriptionLimiter)'));
  assert.ok(src.includes('app.use("/api/v1/status/unsubscribe", statusSubscriptionLimiter)'));
});

/* ------------------------------------- 5. eligibility check relays a refusal */

test("profile check: a backend maintenance reaches the app as MAINTENANCE_ACTIVE, not 'profile unavailable'", async () => {
  process.env.PRINCIPAL_API_BASE_URL = process.env.PRINCIPAL_API_BASE_URL || "http://principal.test";
  fakeAxios.get = () => fakeAxios();
  nextResponse = {
    status: 503,
    headers: { "x-paynoval-service-control": "MAINTENANCE_ACTIVE", "retry-after": "900" },
    data: { success: false, code: "MAINTENANCE_ACTIVE", message: "PayNoval est en maintenance." },
  };

  const eligibility = require("../../src/middlewares/requireTransactionEligibility");
  const res = fakeRes();
  let nextCalled = false;
  await eligibility({ headers: { authorization: "Bearer t" }, user: { _id: "u1" }, body: {} }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "MAINTENANCE_ACTIVE");
  assert.equal(res.headers["Retry-After"], "900");
});

test("profile check: a real outage still says 'profile unavailable'", async () => {
  fakeAxios.get = () => fakeAxios();
  nextResponse = { status: 503, headers: {}, data: { success: false } };

  const eligibility = require("../../src/middlewares/requireTransactionEligibility");
  const res = fakeRes();
  await eligibility({ headers: { authorization: "Bearer t" }, user: { _id: "u1" }, body: {} }, res, () => {});
  assert.equal(res.body.code !== "MAINTENANCE_ACTIVE", true);
  assert.equal(res.statusCode, 503);
});

/* --------------------------------------------------------------- 6. CORS */

test("CORS lets the console send its 2FA re-authentication header", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const list = src.slice(src.indexOf("const ALLOWED_HEADERS = ["), src.indexOf("];", src.indexOf("const ALLOWED_HEADERS = [")));
  assert.ok(list.includes('"X-Step-Up-Token"'), "without it, every critical console action fails the browser preflight");
  assert.ok(list.includes('"X-App-Platform"'));
});
