"use strict";

/**
 * EVERY SESSION 401 CARRIES A MACHINE-READABLE CODE.
 *
 * The mobile app refreshes the session and replays a request on a 401 — but
 * Tx-Core also answers 401 to a WRONG SECURITY ANSWER on /transactions/confirm.
 * Without a code, the app could not tell "your session expired" from "wrong
 * answer": refreshing and replaying the latter burns a second confirmation
 * attempt of the recipient's limited quota. Stripe and PayPal return a typed
 * error code with every error for exactly this reason.
 *
 * Source guard: every `res.status(401).json({...})` of the auth middleware
 * must include a `code`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "middlewares", "auth.js"),
  "utf8"
);

test("every 401 of the auth middleware carries a code", () => {
  const bodies = [...SOURCE.matchAll(/res\.status\(401\)\.json\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);

  assert.ok(bodies.length >= 5, `expected at least 5 401 responses, found ${bodies.length}`);

  for (const body of bodies) {
    assert.match(body, /\bcode\s*:/, `401 without code: ${body.trim().slice(0, 80)}`);
  }
});

test("the expired-token 401 is TOKEN_EXPIRED", () => {
  assert.match(SOURCE, /TokenExpiredError[\s\S]{0,200}code:\s*"TOKEN_EXPIRED"/);
});
