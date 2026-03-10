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

  if (action === "deposit" && funds === "bank" && destination === "paynoval") {
    return TRANSACTION_FLOWS.BANK_TRANSFER_TO_PAYNOVAL;
  }

  if (
    (action === "withdraw" || action === "send") &&
    funds === "paynoval" &&
    destination === "bank"
  ) {
    return TRANSACTION_FLOWS.PAYNOVAL_TO_BANK_PAYOUT;
  }

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