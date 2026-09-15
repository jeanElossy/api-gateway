"use strict";

/**
 * `POST /api/v1/pay` — l'éligibilité de la cagnotte est vérifiée AVANT de
 * prélever un invité (2026-09-10).
 *
 * Avant, la passerelle encaissait sans rien savoir de la cagnotte : close, en
 * pause ou à son objectif, elle recevait quand même un prélèvement. Ces tests
 * verrouillent la traduction de la réponse du backend — et surtout qu'une
 * réponse illisible ou absente REFUSE (règle B.2), au lieu de laisser passer.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { interpreterEligibilite } = require("../controllers/paymentController");

test("cagnotte éligible : l'identifiant VÉRIFIÉ est rendu", () => {
  const d = interpreterEligibilite({
    status: 200,
    data: { success: true, data: { eligible: true, cagnotteId: "c1", cagnotteCurrency: "XOF" } },
  });
  assert.deepEqual(d, { ok: true, cagnotteId: "c1", cagnotteCurrency: "XOF" });
});

test("objectif dépassé : 409 avec le restant, jamais un prélèvement", () => {
  const d = interpreterEligibilite({
    status: 200,
    data: { success: true, data: { eligible: false, code: "GOAL_EXCEEDED", remaining: 5000, currency: "XOF" } },
  });
  assert.equal(d.ok, false);
  assert.equal(d.status, 409);
  assert.equal(d.code, "GOAL_EXCEEDED");
  assert.equal(d.details.remaining, 5000);
});

test("cagnotte privée ou sans rail : refus générique GUEST_PAYMENT_DISABLED", () => {
  for (const raison of ["PRIVATE", "NO_GUEST_RAIL", "VAULT_MISSING"]) {
    const d = interpreterEligibilite({ status: 200, data: { success: true, data: { eligible: false, code: raison } } });
    assert.equal(d.code, "GUEST_PAYMENT_DISABLED", raison);
    assert.equal(d.details.reason, raison);
  }
});

test("backend absent, en erreur ou illisible : REFUS 503 — jamais un encaissement non vérifié", () => {
  for (const reponse of [
    { status: 503 },
    { status: 500, data: {} },
    { status: 200, data: { success: false } },
    { status: 200, data: { success: true, data: { eligible: true } } },
  ]) {
    const d = interpreterEligibilite(reponse);
    assert.equal(d.ok, false);
    assert.equal(d.status, 503);
    assert.equal(d.code, "GUEST_ELIGIBILITY_UNAVAILABLE");
  }
});

test("code inconnu : 404", () => {
  assert.equal(interpreterEligibilite({ status: 404 }).code, "CAGNOTTE_NOT_FOUND");
  assert.equal(interpreterEligibilite(null).code, "CAGNOTTE_NOT_FOUND");
});

test("le relais vers Tx-Core n'utilise que l'identifiant vérifié, et vérifie AVANT de relayer", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "paymentController.js"), "utf8");
  const verif = src.indexOf("await verifierEligibiliteInvite(");
  // L'APPEL de relais, pas la mention dans l'en-tête du fichier.
  const relais = src.indexOf("`${base}/api/v1/collections/initiate`");

  assert.ok(verif > 0 && relais > 0);
  assert.ok(verif < relais, "l'éligibilité doit être vérifiée avant le relais d'encaissement");
  // Le bloc `target` du relais : seul l'identifiant vérifié y entre. (La
  // requête d'éligibilité, elle, transmet légitimement celui du client pour
  // que le backend le CONFRONTE au code.)
  const cible = src.slice(src.indexOf("target: {", verif), src.indexOf("}", src.indexOf("target: {", verif)));
  assert.match(cible, /cagnotteId:\s*eligibilite\.cagnotteId/);
  assert.doesNotMatch(cible, /corps\.cagnotteId/);
});
