"use strict";

/**
 * UN SEUL CHEMIN D'AUTORISATION PAR RÔLE
 * ============================================================================
 *
 * `src/middlewares/requireRole.js` a été supprimé le 2026-09-02. Il ne s'agit
 * pas d'un simple ménage : ce fichier était un doublon **divergent** de
 * `src/middlewares/authz.js`, et il divergeait du mauvais côté.
 *
 *   // l'ancien requireRole.js, dans son intégralité
 *   if (!req.user || !roles.includes(req.user.role)) return 403;
 *
 * Il ne connaissait pas le pseudo-rôle `internal-service`, celui que pose le
 * jeton interne. `authz.js:23-30` le REFUSE par défaut et ne l'autorise que si
 * la route le demande explicitement (`{ allowInternal: true }`) — c'est la
 * fermeture d'un contournement où `internal-service` passait TOUS les contrôles
 * de rôle, sur toutes les routes.
 *
 * Le doublon, lui, aurait laissé passer ce rôle partout : il ne le voyait même
 * pas. Il n'avait aucun appelant, mais il portait le nom que l'on tape en
 * autocomplétion, dans le dossier où l'on va chercher un middleware
 * d'autorisation. Un seul import distrait rouvrait la porte.
 *
 * Ce test échoue si le fichier revient — sous ce nom, ou sous un autre nom
 * exportant un contrôle de rôle concurrent depuis `src/middlewares/`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MIDDLEWARES = path.join(__dirname, "..", "..", "src", "middlewares");

test("requireRole.js n'est pas revenu", () => {
  assert.equal(
    fs.existsSync(path.join(MIDDLEWARES, "requireRole.js")),
    false,
    "src/middlewares/requireRole.js est de retour. Il ignore le pseudo-rôle " +
      "`internal-service`, donc il est PLUS permissif que authz.js. " +
      "Utiliser `require('./authz').requireRole`."
  );
});

test("authz.js reste la seule source de requireRole", () => {
  const fichiers = fs
    .readdirSync(MIDDLEWARES)
    .filter((f) => f.endsWith(".js") && f !== "authz.js");

  const coupables = fichiers.filter((f) => {
    const contenu = fs.readFileSync(path.join(MIDDLEWARES, f), "utf8");
    return /(?:function|const)\s+requireRole\b|exports\.requireRole\b/.test(contenu);
  });

  assert.deepEqual(
    coupables,
    [],
    `Ces middlewares définissent un requireRole concurrent : ${coupables.join(", ")}. ` +
      "Un seul contrôle de rôle doit exister, dans authz.js — deux versions divergent " +
      "toujours, et c'est la plus permissive qui fait la faille."
  );
});

test("authz.js refuse internal-service par défaut", () => {
  const authz = fs.readFileSync(path.join(MIDDLEWARES, "authz.js"), "utf8");
  assert.match(
    authz,
    /options\.allowInternal === true/,
    "authz.js n'autorise plus internal-service en opt-in : le contournement est rouvert."
  );
});
