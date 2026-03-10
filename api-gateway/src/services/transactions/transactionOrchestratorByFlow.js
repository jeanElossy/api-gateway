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
 *
 * Correctifs robustesse :
 * - normalisation des security fields
 * - normalisation des pays (FR, CI, ...)
 * - normalisation method / txType
 * - support pricingId OU quoteId
 * - support payload mobile "souple" -> payload TX Core "strict"
 * - logs détaillés gateway
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

function norm(v) {
  return String(v || "").trim();
}

function lower(v) {
  return norm(v).toLowerCase();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function isNil(v) {
  return v === undefined || v === null;
}

function toSafeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function cleanUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(cleanUndefinedDeep);
  }

  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isNil(val)) continue;
    out[key] = cleanUndefinedDeep(val);
  }
  return out;
}

const COUNTRY_ALIASES = {
  "cote d'ivoire": "CI",
  "cote d ivoire": "CI",
  "cote divoire": "CI",
  "ivory coast": "CI",
  france: "FR",
  belgique: "BE",
  belgium: "BE",
  allemagne: "DE",
  germany: "DE",
  canada: "CA",
  usa: "US",
  us: "US",
  "united states": "US",
  senegal: "SN",
  mali: "ML",
  "burkina faso": "BF",
  cameroun: "CM",
  cameroon: "CM",
};

function normalizeCountry(v) {
  const raw = lower(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return "";

  if (/^[A-Z]{2}$/i.test(norm(v))) {
    return upper(v);
  }

  if (COUNTRY_ALIASES[raw]) {
    return COUNTRY_ALIASES[raw];
  }

  return upper(raw);
}

function normalizeTxType(v) {
  const txType = upper(v);
  if (txType === "DEPOSIT") return "DEPOSIT";
  if (txType === "WITHDRAW") return "WITHDRAW";
  return "TRANSFER";
}

function normalizeMethod(v, { funds = "", destination = "", provider = "" } = {}) {
  const method = upper(v);
  const f = lower(funds);
  const d = lower(destination);
  const p = lower(provider);

  if (method === "INTERNAL") return "INTERNAL";

  if (f === "paynoval" && d === "paynoval") {
    return "INTERNAL";
  }

  if (method === "BANK") return "BANK";
  if (method === "CARD") return "CARD";
  if (method === "MOBILEMONEY") return "MOBILEMONEY";
  if (method === "MOBILE_MONEY") return "MOBILEMONEY";

  if (d === "bank" || p === "bank") return "BANK";
  if (d === "mobilemoney" || p === "mobilemoney") return "MOBILEMONEY";
  if (d === "stripe" || p === "stripe" || p === "visa_direct") return "CARD";

  return method || "INTERNAL";
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

  console.log("[Gateway][fetchCanonicalTransaction] start", {
    transactionId,
    url,
  });

  try {
    const response = await safeAxiosRequest({
      method: "get",
      url,
      headers: auditForwardHeaders(req),
      timeout: 10000,
    });

    const extracted = extractCanonicalTx(response.data || {});

    console.log("[Gateway][fetchCanonicalTransaction] success", {
      transactionId,
      found: !!extracted,
      provider: extracted?.provider,
      flow: extracted?.flow,
      status: extracted?.status,
    });

    return extracted;
  } catch (err) {
    console.error("[Gateway][fetchCanonicalTransaction] failed", {
      transactionId,
      message: err?.message,
      status: err?.status || err?.response?.status,
      responseData: err?.response?.data,
    });
    return null;
  }
}

function normalizeRecipientInfo(body = {}) {
  const original =
    body?.recipientInfo && typeof body.recipientInfo === "object"
      ? body.recipientInfo
      : {};

  const email = lower(body?.toEmail || original?.email || original?.mail || "");
  let name = norm(
    original?.name ||
      original?.accountHolderName ||
      original?.holder ||
      ""
  );

  if (email && name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    name = "";
  }

  return cleanUndefinedDeep({
    ...original,
    email: email || undefined,
    name: name || undefined,
    accountHolderName: norm(original?.accountHolderName || name) || undefined,
    holder: norm(original?.holder) || undefined,
    bankName: norm(original?.bankName) || undefined,
    country: norm(original?.country) || undefined,
    generic: norm(original?.generic) || undefined,
    operator: norm(original?.operator) || undefined,
    phone: norm(original?.phone) || undefined,
    numero: norm(original?.numero) || undefined,
    summary: norm(original?.summary) || name || email || undefined,
  });
}

function buildStrictInitiateBody(rawBody = {}, flow, provider) {
  const body = normalizeSecurityFields(rawBody || {});

  const funds = lower(body.funds);
  const destination = lower(body.destination);
  const normalizedProvider = lower(
    provider || body.provider || funds || destination || "paynoval"
  );

  const method = normalizeMethod(body.method, {
    funds,
    destination,
    provider: normalizedProvider,
  });

  const txType = normalizeTxType(body.txType);

  const pricingId = norm(body.pricingId);
  const quoteId = norm(body.quoteId);
  const effectivePricingId = pricingId || quoteId;

  const country = normalizeCountry(
    body.country || body.toCountry || body.destinationCountry
  );

  const fromCountry = normalizeCountry(
    body.fromCountry || body.sourceCountry || body.country
  );

  const toCountry = normalizeCountry(
    body.toCountry || body.destinationCountry || body.country
  );

  const recipientInfo = normalizeRecipientInfo(body);
  const toEmail = lower(body.toEmail || recipientInfo?.email || "");

  const amountSource = Number(body.amountSource ?? body.amount ?? 0) || 0;
  const feeSource = Number(body.feeSource ?? body.transactionFees ?? 0) || 0;
  const amountTarget = Number(body.amountTarget ?? body.localAmount ?? 0) || 0;
  const exchangeRate =
    Number(body.fxRateSourceToTarget ?? body.exchangeRate ?? 0) || 0;

  const strictBody = cleanUndefinedDeep({
    ...body,

    provider: normalizedProvider,
    funds,
    destination,
    method,
    txType,

    pricingId: pricingId || undefined,
    quoteId: quoteId || undefined,
    effectivePricingId: effectivePricingId || undefined,

    country: country || undefined,
    fromCountry: fromCountry || undefined,
    toCountry: toCountry || undefined,
    sourceCountry: fromCountry || undefined,
    destinationCountry: toCountry || undefined,
    targetCountry: toCountry || undefined,

    toEmail: toEmail || undefined,
    recipientInfo,

    securityQuestion: norm(body.securityQuestion) || undefined,
    securityAnswer: norm(body.securityAnswer) || undefined,

    amount: amountSource,
    amountSource,
    feeSource,
    amountTarget,
    exchangeRate,
    fxRateSourceToTarget: exchangeRate,

    currency: upper(body.currency || body.currencySource || ""),
    currencySource: upper(body.currencySource || body.currency || ""),
    currencyTarget: upper(body.currencyTarget || body.localCurrencyCode || ""),
    senderCurrencyCode: upper(
      body.senderCurrencyCode || body.currencySource || body.currency || ""
    ),
    localCurrencyCode: upper(
      body.localCurrencyCode || body.currencyTarget || ""
    ),

    meta: cleanUndefinedDeep({
      ...(body.meta || {}),
      flow:
        body?.meta?.flow ||
        (flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER
          ? "PAYNOVAL_TO_PAYNOVAL"
          : "EXTERNAL"),
      pricingId: pricingId || undefined,
      quoteId: quoteId || undefined,
      effectivePricingId: effectivePricingId || undefined,
    }),
  });

  return strictBody;
}

async function resolveRouteContextForAction(req, action) {
  normalizeMobileMoneyProviderInBody(req);

  const body =
    action === "confirm"
      ? normalizeSecurityFields(req.body || {})
      : { ...(req.body || {}) };

  console.log("[Gateway][resolveRouteContextForAction] input", {
    action,
    body,
  });

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

  console.log("[Gateway][resolveRouteContextForAction] resolved", {
    action,
    transactionId,
    flow,
    provider,
    serviceUrl,
    canonicalFound: !!canonicalTx,
    canonicalProvider: canonicalTx?.provider,
    canonicalFlow: canonicalTx?.flow,
  });

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
  console.log("[Gateway][dispatchToProvider] start", {
    provider,
    serviceUrl,
    endpoint,
    body,
  });

  try {
    let out;

    switch (provider) {
      case "mobilemoney":
        out = await postToMobileMoneyService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;

      case "bank":
        out = await postToBankService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;

      case "stripe":
      case "visa_direct":
        out = await postToCardService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;

      case "paynoval":
      default:
        out = await postToPaynovalService({
          req,
          serviceUrl,
          endpoint,
          body,
        });
        break;
    }

    console.log("[Gateway][dispatchToProvider] success", {
      provider,
      endpoint,
      status: out?.status,
      body: out?.body,
    });

    return out;
  } catch (err) {
    console.error("[Gateway][dispatchToProvider] failed", {
      provider,
      endpoint,
      serviceUrl,
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
      body,
    });
    throw err;
  }
}

async function routeInitiateByFlow(req) {
  try {
    normalizeMobileMoneyProviderInBody(req);

    console.log("[Gateway][routeInitiateByFlow] raw body", req.body);

    const flow = resolveTransactionFlow(req.body || {});
    const userId = getUserId(req);

    console.log("[Gateway][routeInitiateByFlow] resolved flow", {
      flow,
      userId,
    });

    if (!userId) {
      const e = new Error("Non autorisé (utilisateur manquant).");
      e.status = 401;
      throw e;
    }

    if (flow === TRANSACTION_FLOWS.MOBILEMONEY_COLLECTION_TO_PAYNOVAL) {
      console.log("[Gateway][routeInitiateByFlow] enforceDepositPhoneTrust start");
      await enforceDepositPhoneTrust(req);
      console.log("[Gateway][routeInitiateByFlow] enforceDepositPhoneTrust success");
    }

    const bodyWithSecurity = normalizeSecurityFields(req.body || {});
    const provider = getProviderForFlow({
      flow,
      body: bodyWithSecurity,
      canonicalTx: null,
    });
    const serviceUrl = getTargetService(provider);

    console.log("[Gateway][routeInitiateByFlow] provider resolved", {
      flow,
      provider,
      serviceUrl,
      bodyWithSecurity,
    });

    if (!serviceUrl) {
      const e = new Error(`Aucun service configuré pour le provider: ${provider}`);
      e.status = 400;
      throw e;
    }

    const strictBody = buildStrictInitiateBody(bodyWithSecurity, flow, provider);

    console.log("[Gateway][routeInitiateByFlow][strictBody]", strictBody);
    console.log(
      "[Gateway][routeInitiateByFlow][strictBody.json]",
      toSafeJson(strictBody)
    );

    if (!strictBody.effectivePricingId) {
      const e = new Error("pricingId ou quoteId requis");
      e.status = 400;
      throw e;
    }

    if (!strictBody.amount || strictBody.amount <= 0) {
      const e = new Error("Montant invalide");
      e.status = 400;
      throw e;
    }

    if (!strictBody.fromCountry || !strictBody.toCountry) {
      const e = new Error("Pays source/destination invalides");
      e.status = 400;
      throw e;
    }

    if (
      flow === TRANSACTION_FLOWS.PAYNOVAL_INTERNAL_TRANSFER &&
      !strictBody.toEmail
    ) {
      const e = new Error("Email du destinataire requis pour un transfert interne");
      e.status = 400;
      throw e;
    }

    req.transactionFlow = flow;
    req.providerSelected = provider;
    req.routedProvider = provider;
    req.body = strictBody;

    console.log("[Gateway][routeInitiateByFlow] dispatching", {
      flow,
      provider,
      serviceUrl,
      endpoint: "/transactions/initiate",
    });

    return await dispatchToProvider({
      req,
      provider,
      serviceUrl,
      endpoint: "/transactions/initiate",
      body: strictBody,
    });
  } catch (err) {
    console.error("[Gateway][routeInitiateByFlow] failed", {
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
      requestBody: req?.body,
    });
    throw err;
  }
}

async function routeActionByFlow(req, action) {
  try {
    console.log("[Gateway][routeActionByFlow] start", {
      action,
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const ctx = await resolveRouteContextForAction(req, action);

    console.log("[Gateway][routeActionByFlow] ctx", {
      action,
      flow: ctx.flow,
      provider: ctx.provider,
      serviceUrl: ctx.serviceUrl,
      body: ctx.body,
    });

    return await dispatchToProvider({
      req,
      provider: ctx.provider,
      serviceUrl: ctx.serviceUrl,
      endpoint: `/transactions/${action}`,
      body: ctx.body,
    });
  } catch (err) {
    console.error("[Gateway][routeActionByFlow] failed", {
      action,
      message: err?.message,
      status: err?.status || err?.response?.status,
      payload: err?.payload,
      responseData: err?.response?.data,
      stack: err?.stack,
    });
    throw err;
  }
}

module.exports = {
  normalizeSecurityFields,
  normalizeCountry,
  normalizeMethod,
  normalizeTxType,
  normalizeRecipientInfo,
  buildStrictInitiateBody,
  getProviderForFlow,
  fetchCanonicalTransaction,
  resolveRouteContextForAction,
  routeInitiateByFlow,
  routeActionByFlow,
};