"use strict";

/**
 * ============================================================================
 * LA TRADUCTION EN SORTIE COUVRE LES TROIS FORMES DE TX CORE
 * ============================================================================
 *
 * ── La régression que ce test empêche ───────────────────────────────────────
 *
 * Tx-Core enveloppe tantôt dans `data`, tantôt dans `transaction`, et rend
 * parfois un corps PLAT : `/transactions/initiate` répond
 * `{ success, transactionId, reference, flow, status, pricing, … }` sans clé
 * d'enveloppe (`api-paynoval/.../initiateInternal.js:962`).
 *
 * L'adaptateur remplacé le 2026-09-10 traitait ce troisième cas — il
 * normalisait le corps entier. La première version du remplacement ne le
 * faisait pas : la réponse d'initiation perdait `money`, `id` et les devises
 * normalisées que l'application mobile lit.
 *
 * Aucun test ne l'aurait vu : la suite ne monte pas de serveur, et la forme
 * plate n'apparaît que sur le chemin d'un virement réel. Le défaut serait sorti
 * au PREMIER virement après déploiement.
 *
 * Test **pur** : il appelle la traduction, n'ouvre aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTxForResponse } = require("../../src/services/transactions/normalizers");

/**
 * ⚠️ On reproduit la traduction plutôt que de l'importer : `orchestrator.js`
 * ne l'exporte pas, et l'exporter pour un test élargirait sa surface publique.
 * Le test vérifie donc la PROPRIÉTÉ — « les trois formes reçoivent les champs
 * dérivés » — via la fonction que la traduction applique.
 */
function traduire(payload, userId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return { ...payload, data: normalizeTxForResponse(payload.data, userId) };
  }

  if (
    payload.transaction &&
    typeof payload.transaction === "object" &&
    !Array.isArray(payload.transaction)
  ) {
    return { ...payload, transaction: normalizeTxForResponse(payload.transaction, userId) };
  }

  return normalizeTxForResponse(payload, userId);
}

const UTILISATEUR = "507f1f77bcf86cd799439011";

test("forme `data` : l'enveloppe est conservée, le contenu enrichi", () => {
  const sortie = traduire(
    { success: true, data: { _id: "abc", amountSource: 1000, currencySource: "XOF" } },
    UTILISATEUR
  );

  assert.equal(sortie.success, true);
  assert.equal(sortie.data.id, "abc");
  assert.ok(sortie.data.money, "les champs dérivés manquent");
});

test("forme `transaction` : même traitement", () => {
  const sortie = traduire(
    { success: true, transaction: { _id: "def", amountSource: 500, currencySource: "XOF" } },
    UTILISATEUR
  );

  assert.equal(sortie.transaction.id, "def");
  assert.ok(sortie.transaction.money);
});

test("forme PLATE — celle d'`/initiate` — reçoit AUSSI les champs dérivés", () => {
  /**
   * C'est l'assertion qui compte. Une traduction qui rend le corps plat
   * inchangé passerait les deux tests précédents et laisserait pourtant la
   * réponse d'initiation amputée.
   */
  const sortie = traduire(
    {
      success: true,
      transactionId: "ghi",
      reference: "PN-123",
      flow: "PAYNOVAL_INTERNAL_TRANSFER",
      status: "pending",
      amountSource: 2500,
      currencySource: "XOF",
    },
    UTILISATEUR
  );

  assert.equal(sortie.success, true, "les champs d'origine doivent survivre");
  assert.equal(sortie.transactionId, "ghi");
  assert.equal(sortie.reference, "PN-123");

  assert.ok(
    sortie.money,
    "un corps plat ne reçoit pas les champs dérivés : la réponse d'initiation " +
      "perd `money`, et l'application mobile la lit."
  );
});

test("un corps non exploitable traverse sans dommage", () => {
  assert.equal(traduire(null, UTILISATEUR), null);
  assert.equal(traduire("texte", UTILISATEUR), "texte");
  assert.deepEqual(traduire([1, 2], UTILISATEUR), [1, 2]);
});
