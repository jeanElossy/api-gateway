"use strict";

/**
 * Page 3-D Secure de TEST (mode simulation, 2026-10-06). Chaque test échoue si
 * l'on réintroduit la faute qu'il garde : redirecteur ouvert, injection HTML,
 * ressource externe, sous-arbre `/api/v1/sandbox` ouvert sans JWT.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = require("../../src/services/sandbox/threeDSPage");

test("le retour n'accepte QUE les schémas de l'application", () => {
  assert.equal(page.safeReturnUrl("paynoval://payment-auth/return"), "paynoval://payment-auth/return");
  assert.equal(page.safeReturnUrl("exp+paynoval://payment-auth/return"), "exp+paynoval://payment-auth/return");
  assert.equal(page.safeReturnUrl("exp://192.168.1.10:8081/--/payment-auth/return"), "exp://192.168.1.10:8081/--/payment-auth/return");

  for (const bad of [
    "https://evil.example/x",
    "http://paynoval.com",
    "javascript:alert(1)",
    "//evil.example",
    'paynoval://x"><script>',
    "data:text/html,x",
    "",
    null,
  ]) {
    assert.equal(page.safeReturnUrl(bad), null, String(bad));
  }
});

test("la cible de retour porte l'issue en simple indice", () => {
  assert.equal(
    page.buildReturnTarget("paynoval://payment-auth/return", "approved"),
    "paynoval://payment-auth/return?status=approved"
  );
  assert.equal(page.buildReturnTarget("https://evil.example", "approved"), null);
});

test("toute donnée affichée est échappée", () => {
  const html = page.renderChallengePage({
    token: "abcdefghijklmnopqrstuvwxyz",
    challenge: { merchant: "<img src=x onerror=1>", amount: 5000, currency: "XOF", reference: "<b>R</b>" },
    returnUrl: "paynoval://payment-auth/return",
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>R<\/b>/);
  // Filmée pour le montage : aucune mention de simulation (2026-10-07).
  assert.doesNotMatch(html, /SIMULATION|carte de test|argent réel/i);
  assert.match(html, /name="return_url" value="paynoval:\/\/payment-auth\/return"/);
  // Aucune ressource externe, aucun script.
  assert.doesNotMatch(html, /<script|https?:\/\//i);
});

test("la politique de contenu interdit tout sauf le formulaire", () => {
  assert.match(page.CSP, /default-src 'none'/);
  assert.match(page.CSP, /frame-ancestors 'none'/);
});

test("seule la page 3DS est publique ; les outils exigent le JWT", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../src/app.js"), "utf8");
  assert.match(app, /"\/api\/v1\/sandbox\/3ds",/);
  assert.doesNotMatch(app, /"\/api\/v1\/sandbox",\n/);

  const routes = fs.readFileSync(path.join(__dirname, "../../routes/sandbox.js"), "utf8");
  const protectAt = routes.indexOf("router.use(protect);");
  assert.ok(protectAt > routes.indexOf('router.post("/3ds/:token"'), "protect doit précéder les outils");
  assert.ok(protectAt < routes.indexOf('router.get("/state"'), "les outils doivent être derrière protect");
});
