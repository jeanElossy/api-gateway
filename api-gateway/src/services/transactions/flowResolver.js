"use strict";

/**
 * Résolution du flow métier à partir du body initiateur.
 * Pour les actions sur transaction existante (confirm/cancel/...),
 * le flow réel doit idéalement venir de la transaction canonique.
 */

const {
  normalizeMobileMoneyProviderInBody,
  normalizeProviderForRouting,
  resolveProvider,
  computeProviderSelected,
} = require("./providerRegistry");

const { TRANSACTION_FLOWS } = require("./transactionFlow.constants");

function low(v) {
  return String(v || "").toLowerCase().trim();
}

function normalizeRail(v) {
  const s = low(v);
  if (["visa_direct", "visadirect", "stripe"].includes(s)) return "card";
  return s;
}

function resolveTransactionFlow(payload = {}) {
  const funds = normalizeRail(payload.funds);
  const destination = normalizeRail(payload.destination);
  const action = low(payload.action || "send");

  if (funds === "paynoval" && destination === "paynoval") {
    return TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER;
  }

  if (action === "deposit" && funds === "mobilemoney" && destination === "paynoval") {
    return TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL;
  }

  if (
    (action === "withdraw" || action === "send") &&
    funds === "paynoval" &&
    destination === "mobilemoney"
  ) {
    return TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT;
  }

  if (action === "deposit" && funds === "card" && destination === "paynoval") {
    return TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL;
  }

  if (
    (action === "withdraw" || action === "send") &&
    funds === "paynoval" &&
    destination === "card"
  ) {
    return TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT;
  }

  /**
   * ⚠️ AUCUNE DEMANDE NE DEVIENT PLUS UN FLUX BANCAIRE. Retiré le 2026-08-26.
   *
   * Deux branches se trouvaient ici : `deposit` depuis « bank », et `withdraw`
   * ou `send` vers « bank ». Elles fabriquaient `BANK_TRANSFER_TO_PAYNOVAL` et
   * `PAYNOVAL_TO_BANK_PAYOUT`.
   *
   * Le §1 de l'architecture cible dit que PayNoval n'a AUCUN rail bancaire
   * direct. PayNoval démarre sur trois rails : interne, mobile money, cartes.
   *
   * C'EST ICI QUE LA PORTE SE FERME, et c'est le bon endroit : `flowResolver`
   * est le seul point qui traduit une demande utilisateur en flux. Une demande
   * bancaire tombe désormais en `UNKNOWN_FLOW`, que l'orchestrateur refuse —
   * plutôt que d'être routée vers un rail de remplacement, ce qui déplacerait
   * de l'argent par un chemin que personne n'a choisi.
   *
   * Les CONSTANTES de flux bancaires sont conservées : des transactions
   * héritées peuvent les porter, et l'admin doit pouvoir les lire, les annuler
   * et les rembourser. On ferme la création, pas la lecture.
   */

  return TRANSACTION_FLOWS.UNKNOWN_FLOW;
}

function resolveProviderAndFlowForInitiate(req) {
  normalizeMobileMoneyProviderInBody(req);

  const actionTx = low(req.body?.action || "send");
  const funds = req.body?.funds;
  const destination = req.body?.destination;

  let providerSelected = normalizeProviderForRouting(
    resolveProvider(req, computeProviderSelected(actionTx, funds, destination))
  );

  if (
    low(funds) === "mobilemoney" ||
    low(destination) === "mobilemoney"
  ) {
    providerSelected = "mobilemoney";
  }

  const flow = resolveTransactionFlow(req.body || {});
  req.transactionFlow = flow;
  req.providerSelected = providerSelected;
  req.routedProvider = providerSelected;

  return { flow, provider: providerSelected };
}

module.exports = {
  resolveTransactionFlow,
  resolveProviderAndFlowForInitiate,
};