"use strict";

/** Frontière des mondes à la passerelle (2026-10-31). */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { evaluateTokenEnvironment, auditEnvironment } = require("../src/services/sandboxEnvironment");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("protect applique le monde du jeton avant de lire l'identité", () => {
  const src = read("src/middlewares/auth.js");
  const contrôle = src.indexOf("evaluateTokenEnvironment({ appEnv: APP_ENV");
  assert.ok(contrôle > 0);
  assert.ok(contrôle < src.indexOf("const userId = resolveUserIdFromPayload(payload);"));
});

test("le démarrage applique la frontière avant de charger l'application", () => {
  const src = read("src/server.js");
  const frontiere = src.indexOf("assertEnvironmentBoundary()");
  assert.ok(frontiere > 0);
  assert.ok(frontiere < src.indexOf("require('./app')"));
});

test("un jeton de production est refusé en simulation", () => {
  assert.equal(evaluateTokenEnvironment({ appEnv: "sandbox", claimedEnv: "production" }).code, "ENV_TOKEN_MISMATCH");
});

test("SENDGRID_API_KEY empêche la passerelle de simulation de démarrer", () => {
  const { violations } = auditEnvironment({
    APP_ENV: "sandbox",
    SANDBOX_MODE_ENABLED: "true",
    JWT_ISSUER: "paynoval-sandbox",
    SENDGRID_API_KEY: "x",
  });
  assert.deepEqual(violations.map((v) => v.code), ["REAL_CREDENTIAL_IN_SANDBOX"]);
});
