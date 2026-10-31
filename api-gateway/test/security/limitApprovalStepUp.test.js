"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const jwt = require("jsonwebtoken");

const { AUDIENCE, PURPOSE, isValidStepUp, stepUpKey } = require("../../src/middlewares/requireStepUp");

const SECRET = "test-secret-at-least-16-chars";
const USER = "64ab64ab64ab64ab64ab64ab";

const sign = (overrides = {}, key = stepUpKey(SECRET)) =>
  jwt.sign({ purpose: PURPOSE, ...overrides.claims }, key, {
    algorithm: "HS256",
    audience: overrides.audience || AUDIENCE,
    subject: overrides.subject || USER,
    expiresIn: overrides.expiresIn || 300,
  });

test("a step-up token of this account passes", () => {
  assert.equal(isValidStepUp(sign(), USER, SECRET), true);
});

test("another account's token is refused", () => {
  assert.equal(isValidStepUp(sign({ subject: "74ab64ab64ab64ab64ab64ab" }), USER, SECRET), false);
});

test("an access token signed with the plain secret is refused", () => {
  assert.equal(isValidStepUp(sign({}, SECRET), USER, SECRET), false);
});

test("an expired, wrongly targeted or missing token is refused", () => {
  assert.equal(isValidStepUp(sign({ expiresIn: -10 }), USER, SECRET), false);
  assert.equal(isValidStepUp(sign({ audience: "other" }), USER, SECRET), false);
  assert.equal(isValidStepUp(undefined, USER, SECRET), false);
  assert.equal(isValidStepUp(sign(), USER, ""), false);
});

test("approving a limit policy goes through the step-up", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "..", "routes", "limitPoliciesRoutes.js"), "utf8");
  assert.match(routes, /"\/:version\/approve",[^\n]*requireStepUp, relais/);
});

test("the claims match the backend that issues the token", () => {
  const backend = path.join(__dirname, "..", "..", "..", "..", "paynoval-backend", "services", "serviceControl", "stepUp.js");
  if (!fs.existsSync(backend)) return;
  const source = fs.readFileSync(backend, "utf8");
  assert.ok(source.includes(`PURPOSE = "${PURPOSE}"`));
  assert.ok(source.includes(`AUDIENCE = "${AUDIENCE}"`));
});

test("publishing a price asks for a recent 2FA, like a limit", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../routes/pricingChangeRequestsRoutes.js"),
    "utf8"
  );
  assert.match(source, /"\/:id\/approve",[^;]*requireStepUp[^;]*relais/);
  assert.match(source, /"\/:id\/retry-apply",[^;]*requireStepUp[^;]*relais/);
});
