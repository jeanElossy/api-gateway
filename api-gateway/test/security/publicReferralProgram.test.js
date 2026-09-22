"use strict";

/**
 * ============================================================================
 * LE BARÈME DE PARRAINAGE EST PUBLIC — LES RÉCOMPENSES NE LE SONT PAS
 * ============================================================================
 *
 * `GET /api/v1/referrals/program` doit être joignable sans jeton : le site
 * public affiche le barème à un visiteur anonyme, et doit le LIRE plutôt que
 * d'en garder une copie dans ses fichiers de langue (deux copies d'un
 * engagement financier divergent toujours).
 *
 * Mais `/api/v1/referrals` porte aussi `/me`, `/history`, `/rewards` et
 * `/bonus`, qui servent les récompenses NOMINATIVES d'un utilisateur. Ouvrir
 * le préfixe au lieu du chemin exact les exposerait toutes.
 *
 * Ce fichier verrouille les deux faces : ouvert, et pas plus.
 *
 * Tests purs : lecture de source et appel de la fonction de décision réelle.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RACINE = path.resolve(__dirname, "..", "..");
const SOURCE = fs.readFileSync(path.join(RACINE, "src", "app.js"), "utf8");

/** Le corps d'une liste déclarée `const <nom> = [ … ];`, commentaires retirés. */
function corpsDeListe(nom) {
  const debut = SOURCE.indexOf(`const ${nom} = [`);
  assert.notEqual(debut, -1, `liste ${nom} introuvable`);

  const fin = SOURCE.indexOf("\n];", debut);
  assert.notEqual(fin, -1, `fin de ${nom} introuvable`);

  return SOURCE.slice(debut, fin)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("le barème est ouvert en chemin EXACT", () => {
  assert.match(corpsDeListe("OPEN_EXACT"), /"\/api\/v1\/referrals\/program"/);
});

test("le parrainage n'est JAMAIS ouvert en préfixe", () => {
  const prefixes = corpsDeListe("OPEN_PREFIX");

  // Un préfixe `/api/v1/referrals` rendrait publiques /me, /history,
  // /rewards et /bonus — les récompenses nominatives de chaque utilisateur.
  assert.doesNotMatch(prefixes, /"\/api\/v1\/referrals/);
});

test("les routes nominatives ne sont ouvertes nulle part", () => {
  const ouvert = corpsDeListe("OPEN_EXACT") + corpsDeListe("OPEN_PREFIX");

  for (const chemin of ["/me", "/history", "/rewards", "/bonus", "/summary"]) {
    assert.doesNotMatch(
      ouvert,
      new RegExp(`"/api/v1/referrals${chemin}`),
      `/api/v1/referrals${chemin} ne doit pas être ouvert`
    );
  }
});

test("l'espace interne du parrainage reste hors de toute liste d'ouverture", () => {
  const ouvert = corpsDeListe("OPEN_EXACT") + corpsDeListe("OPEN_PREFIX");

  // Ces endpoints DÉCLENCHENT un versement : ils ne s'atteignent que sur le
  // réseau privé (régression déjà corrigée une fois, à ne pas rejouer).
  assert.doesNotMatch(ouvert, /"\/api\/v1\/internal\/referral/);
});

test("la garde détecte réellement une ouverture en préfixe", () => {
  // Une garde muette passerait aussi vert : on prouve qu'elle mord.
  const faux = '\n  "/api/v1/referrals",\n';
  assert.match(faux, /"\/api\/v1\/referrals/);
});
