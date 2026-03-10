"use strict";

/**
 * --------------------------------------------------------------------------
 * Admin Flow Router
 * --------------------------------------------------------------------------
 * Pour les actions admin :
 * - on tente d'abord de charger la transaction canonique existante
 * - puis on route selon son flow réel/provider réel
 * --------------------------------------------------------------------------
 */

const { resolveTransactionFlow } = require("./flowResolver");
const {
  getTargetService,
  normalizeMobileMoneyProviderInBody,
} = require("./providerRegistry");
const { TRANSACTION_FLOWS } = require("./transactionFlow.constants");
const {
  fetchCanonicalTransaction,
} = require("./transactionOrchestratorByFlow");

const { postToPaynovalService } = require("./providerAdapters/paynovalAdapter");
const {
  postToMobileMoneyService,
} = require("./providerAdapters/mobilemoneyAdapter");
const { postToBankService } = require("./providerAdapters/bankAdapter");
const { postToCardService } = require("./providerAdapters/cardAdapter");

function getTransactionIdFromReq(req) {
  return (
    req.body?.transactionId ||
    req.params?.transactionId ||
    req.params?.id ||
    req.query?.transactionId ||
    null
  );
}

function normalizeProviderHint(body = {}) {
  return String(
    body?.providerSelected ||
      body?.provider ||
      body?.metadata?.provider ||
      ""
  )
    .trim()
    .toLowerCase();
}

function getProviderForAdminAction({ flow, body, canonicalTx = null }) {
  const hinted = normalizeProviderHint(body);
  const txProvider = String(
    canonicalTx?.provider ||
      canonicalTx?.metadata?.provider ||
      ""
  )
    .trim()
    .toLowerCase();

  switch (flow) {
    case TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER:
      return "paynoval";

    case TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL:
    case TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT:
      return "mobilemoney";

    case TRANSACTION_FLOWS.BANK_TRANSFER_TO_PAYNOVAL:
    case TRANSACTION_FLOWS.PAYNOVAL_TO_BANK_PAYOUT:
      return "bank";

    case TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL:
      return "stripe";

    case TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT:
      if (txProvider === "stripe" || hinted === "stripe") return "stripe";
      return "visa_direct";

    case TRANSACTION_FLOWS.UNKNOWN_FLOW:
    default:
      if (txProvider) return txProvider;
      if (
        ["wave", "orange", "mtn", "moov", "flutterwave", "mobilemoney"].includes(
          hinted
        )
      ) {
        return "mobilemoney";
      }
      if (hinted === "stripe" || hinted === "visa_direct" || hinted === "visadirect") {
        return hinted === "stripe" ? "stripe" : "visa_direct";
      }
      if (hinted === "bank") return "bank";
      return "paynoval";
  }
}

async function routeAdminActionByFlow(req, action) {
  normalizeMobileMoneyProviderInBody(req);

  const body = { ...(req.body || {}) };
  const transactionId = getTransactionIdFromReq(req);
  const canonicalTx = transactionId
    ? await fetchCanonicalTransaction(req, transactionId)
    : null;

  const flow =
    canonicalTx?.flow ||
    req.transactionFlow ||
    resolveTransactionFlow(body || {});

  const provider = getProviderForAdminAction({
    flow,
    body,
    canonicalTx,
  });

  const serviceUrl = getTargetService(provider);

  if (!serviceUrl) {
    const e = new Error(`Aucun service configuré pour le provider: ${provider}`);
    e.status = 400;
    throw e;
  }

  req.transactionFlow = flow;
  req.providerSelected = provider;
  req.routedProvider = provider;

  switch (provider) {
    case "mobilemoney":
      return postToMobileMoneyService({
        req,
        serviceUrl,
        endpoint: `/transactions/${action}`,
        body,
      });

    case "bank":
      return postToBankService({
        req,
        serviceUrl,
        endpoint: `/transactions/${action}`,
        body,
      });

    case "stripe":
    case "visa_direct":
      return postToCardService({
        req,
        serviceUrl,
        endpoint: `/transactions/${action}`,
        body,
      });

    case "paynoval":
    default:
      return postToPaynovalService({
        req,
        serviceUrl,
        endpoint: `/transactions/${action}`,
        body,
      });
  }
}

module.exports = {
  routeAdminActionByFlow,
};