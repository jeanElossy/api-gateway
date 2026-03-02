// File: src/controllers/pricingController.js
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

function normalizeCountryForFxRules(country) {
  if (!country) return "";
  const iso2 = normalizeCountryISO2(country);
  return upper(iso2 || country);
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

    // général
    country: normalizeCountryForStore(body.country),
    operator: body.operator ? lower(body.operator) : null,
    provider: body.provider ? lower(body.provider) : null,

    // corridor international
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
    country: normalizeCountryForFxRules(request.country),
    fromCountry: normalizeCountryForFxRules(request.fromCountry),
    toCountry: normalizeCountryForFxRules(request.toCountry),
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

    const rules = await PricingRule.find({ active: true }).lean();

    const quote = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
    });

    const adjusted = await getAdjustedRate({
      baseRate: Number(quote?.result?.appliedRate),
      context: buildFxContext(request),
    });

    if (adjusted?.rate && isPositiveNumber(adjusted.rate)) {
      quote.result.marketRate =
        quote.result.marketRate != null ? Number(quote.result.marketRate) : null;

      quote.result.appliedRate = Number(adjusted.rate);
      quote.result.netTo = recomputeNetTo(quote.result, request);
      quote.fxRuleApplied = adjusted.info || null;
    } else {
      quote.fxRuleApplied = adjusted?.info || null;
    }

    return res.status(200).json({
      ok: true,
      mode: "QUOTE",
      request: quote.request,
      result: quote.result,
      ruleApplied: quote.ruleApplied,
      fxRuleApplied: quote.fxRuleApplied || null,
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

    const rules = await PricingRule.find({ active: true }).lean();

    const computed = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
    });

    const adjusted = await getAdjustedRate({
      baseRate: Number(computed?.result?.appliedRate),
      context: buildFxContext(request),
    });

    if (adjusted?.rate && isPositiveNumber(adjusted.rate)) {
      computed.result.appliedRate = Number(adjusted.rate);
      computed.result.netTo = recomputeNetTo(computed.result, request);
      computed.fxRuleApplied = adjusted.info || null;
    } else {
      computed.fxRuleApplied = adjusted?.info || null;
    }

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
      ruleApplied: computed.ruleApplied,
      fxRuleApplied: computed.fxRuleApplied || null,
      expiresAt,
    });

    return res.status(200).json({
      ok: true,
      mode: "LOCKED",
      quoteId: doc.quoteId,
      expiresAt: doc.expiresAt,
      request: doc.request,
      result: doc.result,
      ruleApplied: doc.ruleApplied,
      fxRuleApplied: doc.fxRuleApplied || null,
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