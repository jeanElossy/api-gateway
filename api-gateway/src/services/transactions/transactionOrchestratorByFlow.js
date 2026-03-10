"use strict";

/**
 * --------------------------------------------------------------------------
 * Transaction Orchestrator By Flow
 * --------------------------------------------------------------------------
 * Gateway = orchestrateur métier léger.
 *
 * Règles :
 * - initiate : le flow peut être résolu depuis le body
 * - confirm/cancel/... : on tente d'abord de lire la transaction canonique
 *   existante depuis le service PayNoval/TX Core
 * - le provider réel d'une action doit venir en priorité :
 *   1) de la transaction canonique
 *   2) du flow
 *   3) du body en dernier recours
 * --------------------------------------------------------------------------
 */

const {
  TRANSACTION_FLOWS,
  getDefaultProviderForFlow,
} = require("./transactionFlow.constants");

const {
  getTargetService,
  normalizeMobileMoneyProviderInBody,
  normalizeProviderForRouting,
} = require("./providerRegistry");

const { resolveTransactionFlow } = require("./flowResolver");
const {
  enforceDepositPhoneTrust,
  getUserId,
  auditForwardHeaders,
} = require("./phoneSecurity");
const { safeAxiosRequest } = require("./httpClient");

const { postToPaynovalService } = require("./providerAdapters/paynovalAdapter");
const { postToMobileMoneyService } = require("./providerAdapters/mobilemoneyAdapter");
const { postToBankService } = require("./providerAdapters/bankAdapter");
const { postToCardService } = require("./providerAdapters/cardAdapter");

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeSecurityFields(body = {}) {
  const out = { ...(body || {}) };

  out.securityQuestion =
    out.securityQuestion || out.question || out.validationQuestion || null;

  out.securityAnswer =
    out.securityAnswer || out.securityCode || out.validationCode || null;

  return out;
}

function extractCanonicalTx(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.data || payload.transaction || payload;
}

function getTransactionIdFromReq(req) {
  return (
    req.body?.transactionId ||
    req.params?.transactionId ||
    req.params?.id ||
    req.query?.transactionId ||
    null
  );
}

function getProviderForFlow({ flow, body, canonicalTx = null }) {
  const requestedProvider = String(
    canonicalTx?.provider ||
      canonicalTx?.metadata?.provider ||
      canonicalTx?.providerSelected ||
      body?.providerSelected ||
      body?.provider ||
      body?.metadata?.provider ||
      ""
  )
    .trim()
    .toLowerCase();

  if (flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER) {
    return "paynoval";
  }

  if (
    flow === TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL ||
    flow === TRANSACTION_FLOWS.PAYNOVAL_TO_MOBILEMONEY_PAYOUT
  ) {
    return "mobilemoney";
  }

  if (
    flow === TRANSACTION_FLOWS.BANK_TRANSFER_TO_PAYNOVAL ||
    flow === TRANSACTION_FLOWS.PAYNOVAL_TO_BANK_PAYOUT
  ) {
    return "bank";
  }

  if (flow === TRANSACTION_FLOWS.CARD_TOPUP_TO_PAYNOVAL) {
    return "stripe";
  }

  if (flow === TRANSACTION_FLOWS.PAYNOVAL_TO_CARD_PAYOUT) {
    if (requestedProvider === "stripe") return "stripe";
    return "visa_direct";
  }

  return normalizeProviderForRouting(
    requestedProvider || getDefaultProviderForFlow(flow)
  );
}

async function fetchCanonicalTransaction(req, transactionId) {
  const paynovalServiceUrl = getTargetService("paynoval");
  if (!paynovalServiceUrl || !transactionId) return null;

  const url = `${cleanBaseUrl(paynovalServiceUrl)}/transactions/${encodeURIComponent(
    transactionId
  )}`;

  try {
    const response = await safeAxiosRequest({
      method: "get",
      url,
      headers: auditForwardHeaders(req),
      timeout: 10000,
    });

    return extractCanonicalTx(response.data || {});
  } catch {
    return null;
  }
}

async function resolveRouteContextForAction(req, action) {
  normalizeMobileMoneyProviderInBody(req);

  const body = action === "confirm"
    ? normalizeSecurityFields(req.body || {})
    : { ...(req.body || {}) };

  const transactionId = getTransactionIdFromReq(req);
  const canonicalTx = transactionId
    ? await fetchCanonicalTransaction(req, transactionId)
    : null;

  const flow =
    canonicalTx?.flow ||
    req.transactionFlow ||
    resolveTransactionFlow(body || {});

  const provider = getProviderForFlow({
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

  return {
    flow,
    provider,
    serviceUrl,
    body,
    canonicalTx,
  };
}

async function dispatchToProvider({ req, provider, serviceUrl, endpoint, body }) {
  switch (provider) {
    case "mobilemoney":
      return postToMobileMoneyService({
        req,
        serviceUrl,
        endpoint,
        body,
      });

    case "bank":
      return postToBankService({
        req,
        serviceUrl,
        endpoint,
        body,
      });

    case "stripe":
    case "visa_direct":
      return postToCardService({
        req,
        serviceUrl,
        endpoint,
        body,
      });

    case "paynoval":
    default:
      return postToPaynovalService({
        req,
        serviceUrl,
        endpoint,
        body,
      });
  }
}

async function routeInitiateByFlow(req) {
  normalizeMobileMoneyProviderInBody(req);

  const flow = resolveTransactionFlow(req.body || {});
  const userId = getUserId(req);

  if (!userId) {
    const e = new Error("Non autorisé (utilisateur manquant).");
    e.status = 401;
    throw e;
  }

  if (flow === TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
    await enforceDepositPhoneTrust(req);
  }

  const body = normalizeSecurityFields(req.body || {});
  const provider = getProviderForFlow({ flow, body, canonicalTx: null });
  const serviceUrl = getTargetService(provider);

  if (!serviceUrl) {
    const e = new Error(`Aucun service configuré pour le provider: ${provider}`);
    e.status = 400;
    throw e;
  }

  req.transactionFlow = flow;
  req.providerSelected = provider;
  req.routedProvider = provider;

  return dispatchToProvider({
    req,
    provider,
    serviceUrl,
    endpoint: "/transactions/initiate",
    body,
  });
}

async function routeActionByFlow(req, action) {
  const ctx = await resolveRouteContextForAction(req, action);

  return dispatchToProvider({
    req,
    provider: ctx.provider,
    serviceUrl: ctx.serviceUrl,
    endpoint: `/transactions/${action}`,
    body: ctx.body,
  });
}

module.exports = {
  normalizeSecurityFields,
  getProviderForFlow,
  fetchCanonicalTransaction,
  resolveRouteContextForAction,
  routeInitiateByFlow,
  routeActionByFlow,
};