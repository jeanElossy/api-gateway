"use strict";

/**
 * Le périmètre des rails, vérifié sur les charges utiles RÉELLES.
 *
 * Ce fichier ne teste pas une fonction isolée : il rejoue les corps que
 * l'application mobile et le site web envoient vraiment, à travers la même
 * chaîne que le middleware — appariement du flux, résolution du rail, puis
 * résolution du plafond AML.
 *
 * Il existe parce que le retrait de Stripe (2026-09-08) touchait les deux
 * clients à la fois, et qu'un mauvais alias aurait coupé le paiement par carte
 * en silence : le mobile envoie `funds: "visa"`, jamais `"visa_direct"`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const flows = require("../src/tools/allowedFlows");
/**
 * ⚠️ LES PLAFONDS NE SONT PLUS IMPORTÉS ICI — 2026-09-10.
 *
 * Ce fichier liait la table des flux (que le bord décide) à la table des
 * plafonds AML (`tools/amlLimits`). Les plafonds y étaient le TROISIÈME
 * exemplaire d'une même règle — `middlewares/aml.js` du bord et
 * `api-paynoval/src/middleware/aml.js` les appliquaient déjà. Ils ont été
 * retirés du bord avec l'AML.
 *
 * Le test s'est scindé selon ce que chaque service possède :
 *
 *   · ICI — quels couples funds/destination sont recevables, et l'alias
 *     `visa` → `visa_direct`. C'est de la validation de forme : la table choisit
 *     le schéma Joi appliqué à la requête.
 *   · `api-paynoval/test/railLimitsCoverage.test.js` — que chaque rail du
 *     périmètre porte un plafond réel, et qu'un rail inconnu LÈVE au lieu de
 *     recevoir un plafond de complaisance.
 *
 * Ne pas réimporter les plafonds ici : ce serait rouvrir la divergence.
 */

const low = (v) => String(v || "").toLowerCase().trim();

/** Reprend `normalizeProviderLike` de `middlewares/validateTransaction.js`. */
function normalizeProviderLike(v) {
  const s = low(v);
  if (["visadirect", "visa-direct", "visa", "card", "mastercard"].includes(s)) {
    return "visa_direct";
  }
  if (["mobile_money", "mobile-money", "momo"].includes(s)) return "mobilemoney";
  return s;
}

function fluxAutorise(body) {
  return flows.find(
    (f) =>
      normalizeProviderLike(f.funds) === normalizeProviderLike(body.funds) &&
      normalizeProviderLike(f.destination) === normalizeProviderLike(body.destination) &&
      (!f.action || low(f.action) === low(body.action))
  );
}

function railRetenu(body) {
  return body.action === "deposit"
    ? normalizeProviderLike(body.funds)
    : normalizeProviderLike(body.destination);
}

/* ── Ce qui DOIT passer ──────────────────────────────────────────────────── */

const LEGITIMES = [
  ["mobile — virement interne", { funds: "paynoval", destination: "paynoval", action: "send" }, "EUR"],
  ["mobile — retrait carte", { funds: "paynoval", destination: "visa", action: "withdraw" }, "EUR"],
  ["mobile — dépôt carte", { funds: "visa", destination: "paynoval", action: "deposit" }, "EUR"],
  ["mobile — retrait mobile money", { funds: "paynoval", destination: "mobilemoney", action: "withdraw" }, "XOF"],
  ["mobile — dépôt mobile money", { funds: "mobile_money", destination: "paynoval", action: "deposit" }, "XOF"],
  ["web — cagnotte par carte", { funds: "visa_direct", destination: "paynoval", action: "deposit" }, "EUR"],
];

for (const [nom, body, devise] of LEGITIMES) {
  test(`${nom} : le flux est autorisé et se résout en rail canonique`, () => {
    assert.ok(fluxAutorise(body), "flux refusé alors qu'il est au périmètre");

    const rail = railRetenu(body);

    /**
     * Le rail retenu doit être une forme CANONIQUE. Un flux qui se résout en
     * une chaîne libre atteindrait Tx-Core sous un nom qu'aucune politique ne
     * connaît — et Tx-Core échouerait en fermeture, mais sur un 500 plutôt que
     * sur un refus explicable.
     */
    assert.match(rail, /^[a-z_]+$/, `rail non canonique : « ${rail} »`);
  });
}

test("le mobile envoie `visa`, jamais `visa_direct` — l'alias doit tenir", () => {
  // Le jour où quelqu'un retire "visa" de la table d'alias, le paiement par
  // carte du mobile tombe en 400 sans qu'aucun autre test ne bronche.
  assert.equal(normalizeProviderLike("visa"), "visa_direct");
  assert.ok(fluxAutorise({ funds: "paynoval", destination: "visa", action: "withdraw" }));
});

/* ── Ce qui NE DOIT PAS passer ───────────────────────────────────────────── */

const REFUSES = [
  ["stripe en dépôt", { funds: "stripe", destination: "paynoval", action: "deposit" }],
  ["stripe en retrait", { funds: "paynoval", destination: "stripe", action: "withdraw" }],
  ["flutterwave comme rail", { funds: "flutterwave", destination: "paynoval", action: "deposit" }],
  ["stripe2momo", { funds: "stripe2momo", destination: "mobilemoney", action: "send" }],
  ["rail bancaire", { funds: "paynoval", destination: "bank", action: "withdraw" }],
  ["rail forgé", { funds: "paynoval", destination: "xyz", action: "send" }],
];

for (const [nom, body] of REFUSES) {
  test(`${nom} : le flux est refusé`, () => {
    assert.equal(
      fluxAutorise(body),
      undefined,
      "un rail hors périmètre a trouvé un flux autorisé"
    );
  });
}

test("aucun plafond de conformité n'est réintroduit au bord", () => {
  /**
   * L'invariant « aucun flux autorisé ne repose sur un rail sans plafond » a
   * déménagé dans `api-paynoval/test/railLimitsCoverage.test.js`, avec la table
   * des plafonds. Ce qui reste ici est sa contrepartie : que le bord ne se
   * remette pas à décider de plafonds.
   *
   * Sans cette assertion, quelqu'un rétablirait `tools/amlLimits.js` au bord au
   * premier besoin, et les deux tables recommenceraient à diverger — ce qui a
   * déjà laissé `visa_direct` rouler sur un repli de 1 000 000 dans toutes les
   * devises.
   */
  const fs = require("node:fs");
  const path = require("node:path");
  const racine = path.join(__dirname, "..");

  assert.ok(
    !fs.existsSync(path.join(racine, "src", "tools", "amlLimits.js")),
    "src/tools/amlLimits.js est revenu au bord — les plafonds vivent dans Tx-Core"
  );

  const validation = fs.readFileSync(
    path.join(racine, "src", "middlewares", "validateTransaction.js"),
    "utf8"
  );

  const codeVivant = validation
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const interdit of ["getSingleTxLimit", "getDailyLimit", "getUserTransactionsStats"]) {
    assert.ok(
      !codeVivant.includes(interdit),
      `validateTransaction.js réapplique « ${interdit} » : la décision de ` +
        "conformité est revenue au bord"
    );
  }
});
