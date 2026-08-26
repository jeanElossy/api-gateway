"use strict";

/**
 * Garde : aucune demande ne doit redevenir un flux bancaire.
 *
 * `flowResolver` est le SEUL point qui traduit une demande utilisateur
 * (action + provenance des fonds + destination) en flux de transaction. C'est
 * donc là que la porte se ferme, et c'est là qu'il faut la garder fermée.
 *
 * Le rail bancaire a été retiré le 2026-08-26 : le §1 de l'architecture cible
 * dit que PayNoval n'en a aucun. PayNoval opère sur trois rails — interne,
 * mobile money, cartes.
 *
 * ⚠️ Avant ce test, la résolution bancaire n'était couverte par RIEN : sa
 * suppression n'a fait tomber aucun test. Un chemin d'argent non testé se
 * modifie sans que personne ne s'en aperçoive, dans un sens comme dans l'autre.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * Configuration minimale AVANT le `require` : le module de configuration de la
 * passerelle refuse de se charger sans ces variables, et il est atteint par la
 * chaîne de dépendances du résolveur. Valeurs factices — ce test ne parle à
 * rien, il vérifie une décision pure.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "t".repeat(48);
process.env.SERVICE_PAYNOVAL_URL =
  process.env.SERVICE_PAYNOVAL_URL || "http://localhost:5001";

const { resolveTransactionFlow } = require("../../src/services/transactions/flowResolver");
const {
  TRANSACTION_FLOWS,
} = require("../../src/services/transactions/transactionFlow.constants");

/** Les quatre formes de demande bancaire qui existaient avant le retrait. */
const DEMANDES_BANCAIRES = [
  { action: "deposit", funds: "bank", destination: "paynoval" },
  { action: "withdraw", funds: "paynoval", destination: "bank" },
  { action: "send", funds: "paynoval", destination: "bank" },
  { action: "withdraw", funds: "bank", destination: "bank" },
];

test("toute demande bancaire tombe en UNKNOWN_FLOW", () => {
  for (const demande of DEMANDES_BANCAIRES) {
    assert.equal(
      resolveTransactionFlow(demande),
      TRANSACTION_FLOWS.UNKNOWN_FLOW,
      `${JSON.stringify(demande)} ne doit produire aucun flux bancaire`
    );
  }
});

test("aucune demande ne produit un flux bancaire, quelle que soit la casse", () => {
  // Une normalisation oubliée laisserait passer « Bank » là où « bank » est
  // refusé — la classe de contournement la plus banale.
  for (const variante of ["BANK", "Bank", " bank ", "bank_transfer"]) {
    const flux = resolveTransactionFlow({ action: "withdraw", funds: "paynoval", destination: variante });
    assert.ok(
      flux !== TRANSACTION_FLOWS.PAYNOVAL_TO_BANK_PAYOUT &&
        flux !== TRANSACTION_FLOWS.BANK_TRANSFER_TO_PAYNOVAL,
      `« ${variante} » ne doit produire aucun flux bancaire`
    );
  }
});

test("les trois rails offerts continuent de se résoudre", () => {
  // Une garde qui casserait les rails réels serait pire que le défaut qu'elle
  // corrige. On vérifie que la porte fermée est la bonne.
  assert.equal(
    resolveTransactionFlow({ action: "send", funds: "paynoval", destination: "paynoval" }),
    TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER
  );
  assert.equal(
    resolveTransactionFlow({ action: "withdraw", funds: "paynoval", destination: "mobilemoney" }),
    TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
  );
  assert.equal(
    resolveTransactionFlow({ action: "withdraw", funds: "paynoval", destination: "card" }),
    TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT
  );
});

test("les CONSTANTES bancaires sont conservées — on ferme la création, pas la lecture", () => {
  /**
   * Des transactions héritées peuvent porter ces flux. L'admin doit pouvoir les
   * lire, les annuler et les rembourser ; les e-mails doivent pouvoir les
   * nommer. Retirer les constantes casserait l'administration d'un historique
   * qu'on ne peut pas réécrire — et le §26 interdit de faire disparaître une
   * écriture financière en silence.
   */
  assert.equal(TRANSACTION_FLOWS.BANK_TRANSFER_TO_PAYNOVAL, "BANK_TRANSFER_TO_PAYNOVAL");
  assert.equal(TRANSACTION_FLOWS.PAYNOVAL_TO_BANK_PAYOUT, "PAYNOVAL_TO_BANK_PAYOUT");
});
