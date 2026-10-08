"use strict";

/**
 * ============================================================================
 * LES CONDITIONS D'UTILISATION SONT PUBLIQUES — LA PREUVE D'ACCEPTATION NON
 * ============================================================================
 *
 * `GET /api/v1/legal/terms/current` est lu AVANT l'inscription (écran public
 * de l'app) : il doit être joignable sans jeton. `POST /api/v1/legal/terms/accept`
 * enregistre une preuve NOMINATIVE : il exige un jeton. Ouvrir le préfixe
 * `/api/v1/legal` exposerait la seconde. Ce fichier verrouille les deux faces.
 *
 * Tests purs : lecture de source.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "app.js"), "utf8");

function corpsDeListe(nom) {
  const debut = SOURCE.indexOf(`const ${nom} = [`);
  assert.notEqual(debut, -1, `liste ${nom} introuvable`);
  const fin = SOURCE.indexOf("\n];", debut);
  return SOURCE.slice(debut, fin)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("la lecture des CGU en vigueur est ouverte en chemin EXACT", () => {
  assert.match(corpsDeListe("OPEN_EXACT"), /"\/api\/v1\/legal\/terms\/current"/);
});

test("l'espace /api/v1/legal n'est JAMAIS ouvert en préfixe, ni l'acceptation", () => {
  const ouvert = corpsDeListe("OPEN_EXACT") + corpsDeListe("OPEN_PREFIX");
  assert.doesNotMatch(corpsDeListe("OPEN_PREFIX"), /"\/api\/v1\/legal/);
  assert.doesNotMatch(ouvert, /"\/api\/v1\/legal\/terms\/accept"/);
  assert.doesNotMatch(ouvert, /"\/api\/v1\/legal"\s*,/);
});

test("l'espace KYB n'est plus relayé (V1 : un seul type de compte)", () => {
  assert.doesNotMatch(SOURCE, /"\/api\/v1\/kyb"/);
});
