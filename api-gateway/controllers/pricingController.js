"use strict";

const { v4: uuidv4 } = require("uuid");
const PricingRule = require("../models/PricingRule");
const PricingQuote = require("../models/PricingQuote");
const { computeQuote } = require("../services/pricingEngine");
const { getMarketRate } = require("../services/fxService");
const { getAdjustedRate } = require("../src/services/fxRulesService");

const LOCK_TTL_MIN = Number(process.env.PRICING_LOCK_TTL_MIN || 10);

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query;
}

exports.quote = async (req, res, next) => {
  try {
    const body = pickBody(req);

    const request = {
      txType: body.txType,
      amount: body.amount,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      country: body.country || null,
      operator: body.operator || null,
    };

    const rules = await PricingRule.find({ active: true }).lean();

    // 1) pricingRule calcule fees + rate (market + pricingRule.fx)
    const quote = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRate(from, to),
    });

    // 2) applique FxRule admin global sur le taux final
    const adjusted = await getAdjustedRate({
      baseRate: quote.result.appliedRate,
      context: {
        txType: String(request.txType || "").toUpperCase(),
        provider: "", // si tu veux provider ici, passe-le dans request
        country: (request.country || "").toLowerCase(),
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        amount: Number(request.amount),
      },
    });

    if (adjusted?.rate) {
      // recalcul netTo avec le taux ajusté
      const appliedRate = Number(adjusted.rate);
      quote.result.marketRate = quote.result.marketRate ?? null;
      quote.result.appliedRate = appliedRate;
      quote.result.netTo = quote.result.netFrom * appliedRate;

      quote.fxRuleApplied = adjusted.info || null;
    } else {
      quote.fxRuleApplied = adjusted?.info || null;
    }

    return res.json({ ok: true, mode: "PREVIEW", ...quote });
  } catch (e) {
    return next(e);
  }
};

exports.lock = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const body = pickBody(req);

    const request = {
      txType: body.txType,
      amount: body.amount,
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      country: body.country || null,
      operator: body.operator || null,
    };

    const rules = await PricingRule.find({ active: true }).lean();

    const computed = await computeQuote({
      req: request,
      rules,
      getMarketRate: async (from, to) => getMarketRate(from, to),
    });

    // FxRule admin global
    const adjusted = await getAdjustedRate({
      baseRate: computed.result.appliedRate,
      context: {
        txType: String(request.txType || "").toUpperCase(),
        provider: "",
        country: (request.country || "").toLowerCase(),
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        amount: Number(request.amount),
      },
    });

    if (adjusted?.rate) {
      const appliedRate = Number(adjusted.rate);
      computed.result.appliedRate = appliedRate;
      computed.result.netTo = computed.result.netFrom * appliedRate;
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

      // ✅ ruleApplied bien stocké (PricingRule)
      ruleApplied: computed.ruleApplied,

      // ✅ on garde aussi la règle FX admin (optionnel) dans un champ libre:
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
    return next(e);
  }
};
