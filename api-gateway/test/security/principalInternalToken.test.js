"use strict";

/**
 * Le gateway ne prête son identité de service QUE là où c'est déclaré.
 *
 * Jusqu'au 2026-09-17, `x-internal-token` était ajouté à CHAQUE requête
 * publique relayée vers le backend principal. Toute route du principal
 * protégée par ce seul jeton et située sous un préfixe relayé devenait donc
 * joignable par un appelant du gateway — « député confus ». Ce test échoue si
 * quelqu'un réélargit l'injection.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/** Même amorçage que les autres tests de ce dossier : `src/app` valide la config au require. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "a".repeat(32);
process.env.GATEWAY_INTERNAL_TOKEN = process.env.GATEWAY_INTERNAL_TOKEN || "b".repeat(24);
process.env.SERVICE_PAYNOVAL_URL = process.env.SERVICE_PAYNOVAL_URL || "http://localhost:1";

const {
  needsPrincipalInternalToken,
  PRINCIPAL_INTERNAL_TOKEN_PREFIXES,
} = require("../../src/app");

test("seul /api/v1/fx est signé au nom du gateway", () => {
  assert.deepEqual(PRINCIPAL_INTERNAL_TOKEN_PREFIXES, ["/api/v1/fx"]);

  for (const url of ["/api/v1/fx", "/api/v1/fx/latest", "/api/v1/fx/rate?from=EUR"]) {
    assert.equal(needsPrincipalInternalToken({ originalUrl: url }), true, url);
  }
});

test("aucun autre chemin ne reçoit le jeton interne du principal", () => {
  const interdits = [
    "/api/v1/users/me",
    "/api/v1/admin/referrals/bonuses",
    "/api/v1/internal/referral/award-bonus",
    "/api/v1/internal/referral/clawback",
    "/api/v1/cagnottes",
    "/api/v1/fxx/latest",
    "/api/v1/fx-internal/latest",
    "/",
  ];

  for (const url of interdits) {
    assert.equal(
      needsPrincipalInternalToken({ originalUrl: url }),
      false,
      `${url} ne doit pas être signé au nom du gateway`
    );
  }
});

test("le jeton n'est posé qu'à UN seul endroit du proxy, sous condition", () => {
  const source = fs
    .readFileSync(path.join(__dirname, "..", "..", "src", "app.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const injections = source.match(/setHeader\(\s*\n?\s*"x-internal-token"/g) || [];

  assert.equal(
    injections.length,
    1,
    "une seule injection du jeton interne doit subsister (la poignée de main WebSocket n'en a pas besoin)"
  );

  assert.match(source, /needsPrincipalInternalToken\(req\)/);
});
