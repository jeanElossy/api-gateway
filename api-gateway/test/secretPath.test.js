"use strict";

/** Jetons à usage unique masqués dans les journaux de la passerelle (2026-11-12). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { redactSecretPath } = require("../src/utils/secretPath");

const TOKEN = "a".repeat(64);

test("jetons d'authentification masqués : e-mail, téléphone, mot de passe", () => {
  for (const route of ["auth/verify-email", "auth/verify-phone", "auth/reset-password"]) {
    const out = redactSecretPath(`/api/v1/${route}/${TOKEN}?x=1`);
    assert.equal(out, `/api/v1/${route}/[jeton]?x=1`);
    assert.ok(!out.includes(TOKEN));
  }
});

test("les jetons déjà couverts le restent ; une route ordinaire est intacte", () => {
  assert.equal(redactSecretPath(`/api/v1/demo-invitations/signup/${TOKEN}`), "/api/v1/demo-invitations/signup/[jeton]");
  assert.equal(redactSecretPath(`/api/v1/sandbox/3ds/${TOKEN}`), "/api/v1/sandbox/3ds/[jeton]");
  assert.equal(redactSecretPath("/api/v1/users/me"), "/api/v1/users/me");
  assert.equal(redactSecretPath("/api/v1/auth/resend-verification"), "/api/v1/auth/resend-verification");
});
