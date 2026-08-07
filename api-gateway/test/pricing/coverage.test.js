"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { coverageKey } = require("../../src/services/pricing/coverage");

const base = {
  txType: "TRANSFER",
  method: "MOBILEMONEY",
  provider: "wave",
  fromCurrency: "EUR",
  toCurrency: "XOF",
  fromCountry: "FR",
  toCountry: "CI",
};

test("deux requêtes identiques produisent la même clé", () => {
  assert.equal(coverageKey(base), coverageKey({ ...base }));
});

test("la clé est insensible à la casse et aux espaces", () => {
  const noisy = {
    ...base,
    method: "  mobilemoney ",
    provider: "WAVE",
    fromCurrency: " eur ",
  };
  assert.equal(coverageKey(noisy), coverageKey(base));
});

test("changer un seul élément du périmètre change la clé", () => {
  assert.notEqual(coverageKey(base), coverageKey({ ...base, toCountry: "SN" }));
  assert.notEqual(coverageKey(base), coverageKey({ ...base, method: "BANK" }));
});

test("le montant n'entre pas dans la clé : c'est le corridor qui manque, pas la tranche", () => {
  assert.equal(coverageKey({ ...base, amount: 100 }), coverageKey({ ...base, amount: 999999 }));
});

test("un champ absent devient ALL plutôt que undefined", () => {
  const key = coverageKey({ txType: "TRANSFER", fromCurrency: "EUR", toCurrency: "XOF" });
  assert.match(key, /ALL/);
  assert.ok(!key.includes("undefined"));
});
