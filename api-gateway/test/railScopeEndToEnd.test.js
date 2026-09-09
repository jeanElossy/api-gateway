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
const { getSingleTxLimit, getDailyLimit } = require("../src/tools/amlLimits");

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
  test(`${nom} : le flux est autorisé et porte un plafond réel`, () => {
    assert.ok(fluxAutorise(body), "flux refusé alors qu'il est au périmètre");

    const rail = railRetenu(body);
    const envoi = getSingleTxLimit(rail, devise);
    const jour = getDailyLimit(rail, devise);

    assert.ok(Number.isFinite(envoi) && envoi > 0);
    assert.ok(Number.isFinite(jour) && jour >= envoi);

    // Aucun de ces chemins ne doit retomber sur les anciennes constantes.
    assert.notEqual(envoi, 1_000_000, "plafond de repli détecté");
    assert.notEqual(jour, 5_000_000, "plafond de repli détecté");
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

test("aucun flux autorisé ne repose sur un rail sans plafond", () => {
  /**
   * L'invariant qui manquait. `visa_direct` portait DEUX flux ouverts et zéro
   * ligne dans la table des plafonds : le contrôle AML retombait alors sur
   * 1 000 000, dans toutes les devises. Ce test lie les deux tables — un flux
   * ne peut plus exister sans que sa politique existe.
   */
  for (const f of flows) {
    for (const côté of [f.funds, f.destination]) {
      const rail = normalizeProviderLike(côté);
      if (rail === "paynoval") continue;

      assert.doesNotThrow(
        () => getSingleTxLimit(rail, "EUR"),
        `le flux ${f.funds} → ${f.destination} emprunte le rail « ${rail} », ` +
          "qui n'a aucun plafond AML"
      );
    }
  }
});
