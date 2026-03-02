"use strict";

const { v4: uuidv4 } = require("uuid");

const PricingRule = require("../src/models/PricingRule");
const PricingQuote = require("../src/models/PricingQuote");

const {
  computeQuote,
  roundMoney,
  normalizeCountryISO2,
} = require("../src/services/pricingEngine");

const { getExchangeRate } = require("../src/services/exchangeRateService");
const { getAdjustedRate } = require("../src/services/fxRulesService");

const LOCK_TTL_MIN = Number(process.env.PRICING_LOCK_TTL_MIN || 10);

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query;
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);
  if (["send", "transfer", "transfert"].includes(low)) return "TRANSFER";
  if (["deposit", "cashin", "topup"].includes(low)) return "DEPOSIT";
  if (["withdraw", "withdrawal", "cashout", "retrait"].includes(low)) return "WITHDRAW";

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["MOBILEMONEY", "BANK", "CARD", "INTERNAL"].includes(raw)) return raw;

  const low = lower(v);
  if (["mobilemoney", "mobile_money", "mm"].includes(low)) return "MOBILEMONEY";
  if (["bank", "wire", "transfer_bank", "virement"].includes(low)) return "BANK";
  if (["card", "visa", "mastercard"].includes(low)) return "CARD";
  if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

  return raw;
}

function normalizeCountryForStore(country) {
  if (!country) return null;
  const iso2 = normalizeCountryISO2(country);
  return upper(iso2 || country);
}

function normalizeCountryForRules(country) {
  if (!country) return "";
  const iso2 = normalizeCountryISO2(country);
  return lower(iso2 || country);
}

function pickRequestId(req) {
  return (
    req.get("x-request-id") ||
    req.get("x-correlation-id") ||
    req.get("x-amzn-trace-id") ||
    null
  );
}

function isPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

async function getMarketRateDirect(from, to, { requestId } = {}) {
  const out = await getExchangeRate(from, to, { requestId });
  const rate = Number(out?.rate ?? out);
  return Number.isFinite(rate) ? rate : null;
}

function buildRequest(body = {}) {
  return {
    txType: normalizeTxType(body.txType),
    method: normalizeMethod(body.method),
    amount: Number(body.amount),
    fromCurrency: upper(body.fromCurrency),
    toCurrency: upper(body.toCurrency),

    // ✅ country = destination/general country
    country: normalizeCountryForStore(body.country),
    operator: body.operator ? lower(body.operator) : null,
    provider: body.provider ? lower(body.provider) : null,

    fromCountry: normalizeCountryForStore(body.fromCountry),
    toCountry: normalizeCountryForStore(body.toCountry),
  };
}

function validateRequest(request) {
  if (!request.txType) return "txType est requis";
  if (!request.amount || !Number.isFinite(request.amount) || request.amount <= 0) {
    return "amount doit être un nombre > 0";
  }
  if (!request.fromCurrency) return "fromCurrency est requis";
  if (!request.toCurrency) return "toCurrency est requis";
  return null;
}

function buildFxContext(request) {
  return {
    txType: upper(request.txType || ""),
    method: upper(request.method || ""),
    provider: lower(request.provider || ""),

    // ✅ scope général = country destination
    country: normalizeCountryForRules(request.country),
    fromCountry: normalizeCountryForRules(request.fromCountry),
    toCountry: normalizeCountryForRules(request.toCountry),

    fromCurrency: upper(request.fromCurrency || ""),
    toCurrency: upper(request.toCurrency || ""),
    amount: Number(request.amount || 0),
  };
}

function recomputeNetTo(result, request) {
  const netFrom = Number(result?.netFrom || 0);
  const appliedRate = Number(result?.appliedRate || 0);

  if (!Number.isFinite(netFrom) || !Number.isFinite(appliedRate)) {
    return result?.netTo ?? 0;
  }

  return roundMoney(netFrom * appliedRate, request.toCurrency);
}

function buildDebugPayload({ request, quote, adjusted, requestId }) {
  const fee = Number(quote?.result?.fee || 0);
  const grossFrom = Number(quote?.result?.grossFrom || request?.amount || 0);
  const netFrom = Number(quote?.result?.netFrom || 0);
  const marketRate =
    quote?.result?.marketRate != null ? Number(quote.result.marketRate) : null;
  const appliedRate =
    quote?.result?.appliedRate != null ? Number(quote.result.appliedRate) : null;

  return {
    requestId: requestId || null,

    requestNormalized: {
      txType: request?.txType || null,
      method: request?.method || null,
      amount: Number(request?.amount || 0),
      fromCurrency: request?.fromCurrency || null,
      toCurrency: request?.toCurrency || null,
      country: request?.country || null,
      fromCountry: request?.fromCountry || null,
      toCountry: request?.toCountry || null,
      provider: request?.provider || null,
      operator: request?.operator || null,
    },

    feeSource: fee,
    feeComputation: {
      grossFrom,
      fee,
      netFrom,
      formula:
        Number.isFinite(grossFrom) && Number.isFinite(fee)
          ? `${grossFrom} - ${fee} = ${netFrom}`
          : null,
    },

    feeRuleApplied: quote?.ruleApplied || null,
    fxRuleApplied: adjusted?.info || quote?.fxRuleApplied || null,

    fxComputation: {
      marketRate,
      appliedRate,
      marginDelta:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? appliedRate - marketRate
          : null,
      netTo: Number(quote?.result?.netTo || 0),
    },

    feeBreakdown: quote?.result?.feeBreakdown || null,
  };
}

async function computeFullQuote({ request, requestId }) {
  const rules = await PricingRule.find({ active: true }).lean();

  const quote = await computeQuote({
    req: request,
    rules,
    getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
  });

  const baseRate = Number(quote?.result?.appliedRate);
  const adjusted = await getAdjustedRate({
    baseRate,
    context: buildFxContext(request),
  });

  if (adjusted?.rate && isPositiveNumber(adjusted.rate)) {
    quote.result.marketRate =
      quote.result.marketRate != null
        ? Number(quote.result.marketRate)
        : Number.isFinite(baseRate)
        ? baseRate
        : null;

    quote.result.appliedRate = Number(adjusted.rate);
    quote.result.netTo = recomputeNetTo(quote.result, request);
    quote.fxRuleApplied = adjusted.info || null;
  } else {
    if (quote.result.marketRate == null && Number.isFinite(baseRate)) {
      quote.result.marketRate = baseRate;
    }
    quote.fxRuleApplied = adjusted?.info || null;
  }

  quote.debug = buildDebugPayload({
    request,
    quote,
    adjusted,
    requestId,
  });

  return quote;
}

exports.quote = async (req, res, next) => {
  try {
    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = buildRequest(body);
    const validationError = validateRequest(request);

    if (validationError) {
      return res.status(400).json({
        ok: false,
        error: validationError,
      });
    }

    const quote = await computeFullQuote({ request, requestId });

    return res.status(200).json({
      ok: true,
      mode: "QUOTE",
      request: quote.request,
      result: quote.result,
      feeSource: quote.debug?.feeSource ?? Number(quote?.result?.fee || 0),
      ruleApplied: quote.ruleApplied || null,
      fxRuleApplied: quote.fxRuleApplied || null,
      debug: quote.debug || null,
    });
  } catch (e) {
    if (e && e.status === 404 && e.details) {
      return res.status(404).json({
        ok: false,
        error: e.message || "No pricing rule matched",
        details: e.details,
      });
    }

    if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
      return res.status(503).json({
        ok: false,
        error: "FX rate unavailable",
        details: e.details || null,
      });
    }

    return next(e);
  }
};

exports.lock = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: "Unauthorized",
      });
    }

    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = buildRequest(body);
    const validationError = validateRequest(request);

    if (validationError) {
      return res.status(400).json({
        ok: false,
        error: validationError,
      });
    }

    const computed = await computeFullQuote({ request, requestId });

    const quoteId = uuidv4();
    const expiresAt = new Date(Date.now() + LOCK_TTL_MIN * 60 * 1000);

    const doc = await PricingQuote.create({
      quoteId,
      userId,
      status: "ACTIVE",
      request: {
        txType: computed.request.txType,
        method: computed.request.method || null,
        amount: Number(computed.request.amount),
        fromCurrency: upper(computed.request.fromCurrency),
        toCurrency: upper(computed.request.toCurrency),
        country: normalizeCountryForStore(computed.request.country),
        fromCountry: normalizeCountryForStore(computed.request.fromCountry),
        toCountry: normalizeCountryForStore(computed.request.toCountry),
        operator: computed.request.operator ? lower(computed.request.operator) : null,
        provider: computed.request.provider ? lower(computed.request.provider) : null,
      },
      result: computed.result,
      ruleApplied: computed.ruleApplied || null,
      fxRuleApplied: computed.fxRuleApplied || null,
      debug: computed.debug || null,
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      mode: "LOCKED",
      quoteId: doc.quoteId,
      expiresAt: doc.expiresAt,
      request: doc.request,
      result: doc.result,
      feeSource: doc.debug?.feeSource ?? Number(doc?.result?.fee || 0),
      ruleApplied: doc.ruleApplied || null,
      fxRuleApplied: doc.fxRuleApplied || null,
      debug: doc.debug || null,
    });
  } catch (e) {
    if (e && e.status === 404 && e.details) {
      return res.status(404).json({
        ok: false,
        error: e.message || "No pricing rule matched",
        details: e.details,
      });
    }

    if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
      return res.status(503).json({
        ok: false,
        error: "FX rate unavailable",
        details: e.details || null,
      });
    }

    return next(e);
  }
};