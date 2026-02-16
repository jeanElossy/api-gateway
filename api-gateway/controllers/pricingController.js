"use strict";

const { v4: uuidv4 } = require("uuid");
const PricingRule = require("../src/models/PricingRule");
const PricingQuote = require("../src/models/PricingQuote");
const {
  computeQuote,
  roundMoney,
  normalizeCountryISO2,
} = require("../src/services/pricingEngine");

const { getExchangeRate } = require("../src/services/exchangeRateService"); // ✅ direct JS (pas HTTP)
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

  if (raw === "TRANSFER" || raw === "DEPOSIT" || raw === "WITHDRAW") return raw;

  const low = lower(v);
  if (low === "send" || low === "transfer" || low === "transfert") return "TRANSFER";
  if (low === "deposit" || low === "cashin" || low === "topup") return "DEPOSIT";
  if (low === "withdraw" || low === "withdrawal" || low === "cashout") return "WITHDRAW";

  return raw;
}

function normCountryForRules(country) {
  if (!country) return "";
  const iso2 = normalizeCountryISO2(country);
  // on renvoie ISO2 en lower pour matcher tes fx-rules admin souvent stockées en lower
  return (iso2 || String(country)).toLowerCase();
}

function pickRequestId(req) {
  return (
    req.get("x-request-id") ||
    req.get("x-correlation-id") ||
    req.get("x-amzn-trace-id") ||
    null
  );
}

async function getMarketRateDirect(from, to, { requestId } = {}) {
  // getExchangeRate renvoie souvent { rate, source, stale... }
  const out = await getExchangeRate(from, to, { requestId });
  const rate = Number(out?.rate ?? out);
  return Number.isFinite(rate) ? rate : null;
}

exports.quote = async (req, res, next) => {
  try {
    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = {
      txType: normalizeTxType(body.txType),
      amount: body.amount,
      fromCurrency: upper(body.fromCurrency),
      toCurrency: upper(body.toCurrency),

      // IMPORTANT: on laisse l'engine gérer iso2 + tokens
      country: body.country || null,
      operator: body.operator || null,

      // optionnel (fxRules admin l’utilisent)
      provider: body.provider || null,
    };

    const rules = await PricingRule.find({ active: true }).lean();

    const quote = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
    });

    // 2) applique FxRule admin global sur le taux final
    const adjusted = await getAdjustedRate({
      baseRate: quote.result.appliedRate,
      context: {
        txType: String(request.txType || "").toUpperCase(),
        provider: String(request.provider || "").toLowerCase(),
        country: normCountryForRules(request.country),
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        amount: Number(request.amount),
      },
    });

    if (adjusted?.rate) {
      const appliedRate = Number(adjusted.rate);
      quote.result.marketRate = quote.result.marketRate ?? null;
      quote.result.appliedRate = appliedRate;

      // ✅ recalcul netTo + arrondi devise
      quote.result.netTo = roundMoney(quote.result.netFrom * appliedRate, request.toCurrency);

      quote.fxRuleApplied = adjusted.info || null;
    } else {
      quote.fxRuleApplied = adjusted?.info || null;
    }

    return res.json({ ok: true, mode: "QUOTE", ...quote });
  } catch (e) {
    if (e && e.status === 404 && e.details) {
      return res.status(404).json({
        ok: false,
        error: e.message || "No pricing rule matched",
        details: e.details,
      });
    }

    // ✅ si FX indisponible, renvoyer 503 propre (pas 502)
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
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = {
      txType: normalizeTxType(body.txType),
      amount: body.amount,
      fromCurrency: upper(body.fromCurrency),
      toCurrency: upper(body.toCurrency),
      country: body.country || null,
      operator: body.operator || null,
      provider: body.provider || null,
    };

    const rules = await PricingRule.find({ active: true }).lean();

    const computed = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
    });

    const adjusted = await getAdjustedRate({
      baseRate: computed.result.appliedRate,
      context: {
        txType: String(request.txType || "").toUpperCase(),
        provider: String(request.provider || "").toLowerCase(),
        country: normCountryForRules(request.country),
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        amount: Number(request.amount),
      },
    });

    if (adjusted?.rate) {
      const appliedRate = Number(adjusted.rate);
      computed.result.appliedRate = appliedRate;
      computed.result.netTo = roundMoney(computed.result.netFrom * appliedRate, request.toCurrency);
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
      request: computed.request,
      result: computed.result,
      ruleApplied: computed.ruleApplied,
      fxRuleApplied: computed.fxRuleApplied || null,
      expiresAt,
    });

    return res.json({
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
