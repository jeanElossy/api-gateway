"use strict";

/**
 * Aucune devise inventée dans les messages de la passerelle, et « FCFA » comme
 * graphie d'affichage (2026-11-17).
 *
 * Le suffixe des messages « less than or equal to N » valait « F CFA » par
 * défaut, quelle que soit la demande (même pour un compte canadien). Aucun
 * schéma n'a de plafond `max()` aujourd'hui, donc ce message n'est pas émis ;
 * le jour où il le sera, il portera la devise de la demande, ou aucune.
 * Lecture statique.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");

test("le suffixe de devise des messages ne part d'aucune devise devinée", () => {
  const src = read("src/middlewares/validateTransaction.js");
  assert.match(src, /let currencyForMsg = "";/);
  assert.doesNotMatch(src, /let currencyForMsg = "[^"]+";/);
  assert.match(src, /currencyForMsg \? ` \$\{currencyForMsg\}` : ""/);
});

test("le symbole d'affichage de XOF et XAF est « FCFA »", () => {
  const src = read("src/tools/currency.js");
  assert.match(src, /XOF: "FCFA",/);
  assert.match(src, /XAF: "FCFA",/);
  assert.doesNotMatch(src, /"F CFA"/);
});
