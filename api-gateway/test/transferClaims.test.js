"use strict";

/**
 * `/api/v1/transfer-claims` (2026-11-04) — la passerelle ne relaie qu'une liste
 * fermée de champs bornés, n'en journalise aucun, et n'exige pas de JWT (le
 * destinataire n'a pas de compte : Tx-Core vérifie jeton, code et réponse).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("route publique, montée et ouverte sans JWT", () => {
  const app = read("src/app.js");
  assert.match(app, /app\.use\("\/api\/v1\/transfer-claims", require\("\.\.\/routes\/transferClaims"\)\)/);
  const open = app.slice(app.indexOf("const OPEN_PREFIX = ["), app.indexOf("];", app.indexOf("const OPEN_PREFIX = [")));
  assert.match(open, /"\/api\/v1\/transfer-claims"/);
});

test("liste fermée de champs, bornés ; limite par adresse IP sur chaque route", () => {
  const r = read("routes/transferClaims.js");
  assert.match(r, /const TOKEN = \/\^\[A-Za-z0-9_-\]\{43\}\$\//);
  assert.match(r, /const CODE = \/\^\\d\{6\}\$\//);
  assert.match(r, /answer\.length > 200/);
  for (const action of ["inspect", "code", "claim", "refuse"]) {
    assert.match(r, new RegExp(`router\\.post\\("/${action}", perIp\\(`), action);
  }
  assert.match(r, /Cache-Control", "no-store"/);
});

test("jamais journalisé : jeton, code, réponse", () => {
  const { redactSensitive } = require("../src/utils/redactSensitive");
  const out = redactSensitive({ token: "x".repeat(43), code: "123456", answer: "bleu" });
  assert.deepEqual(Object.values(out).every((v) => v === "[REDACTED]"), true);
  assert.match(read("src/middlewares/logger.js"), /'answer', 'securityAnswer'/);
  assert.doesNotMatch(read("src/app.js"), /\{ body: req\.body \}/);
});
