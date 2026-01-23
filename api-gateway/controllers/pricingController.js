"use strict";

const { v4: uuidv4 } = require("uuid");
const PricingRule = require("../src/models/PricingRule");
const PricingQuote = require("../src/models/PricingQuote");
const { computeQuote } = require("../src/services/pricingEngine");
const { getMarketRate } = require("../src/services/fxService");
const { getAdjustedRate } = require("../src/services/fxRulesService");

const LOCK_TTL_MIN = Number(process.env.PRICING_LOCK_TTL_MIN || 10);

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query;
}

// mini normalizers (controller-level safety)
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

exports.quote = async (req, res, next) => {
  try {
    const body = pickBody(req);

    const request = {
      txType: normalizeTxType(body.txType),
      amount: body.amount,
      fromCurrency: upper(body.fromCurrency),
      toCurrency: upper(body.toCurrency),

      // IMPORTANT: on laisse le moteur gérer ISO2/noms
      country: body.country || null,

      operator: body.operator || null,

      // optionnel (si tu veux plus tard filtrer par provider)
      provider: body.provider || null,
    };

    const rules = await PricingRule.find({ active: true }).lean();

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
        provider: String(request.provider || "").toLowerCase(),
        country: (request.country || "").toLowerCase(),
        fromCurrency: request.fromCurrency,
        toCurrency: request.toCurrency,
        amount: Number(request.amount),
      },
    });

    if (adjusted?.rate) {
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
    // ✅ Si computeQuote a mis e.details, on le renvoie pour debug (sans casser prod)
    if (e && e.status === 404 && e.details) {
      return res.status(404).json({
        ok: false,
        error: e.message || "No pricing rule matched",
        details: e.details,
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
      getMarketRate: async (from, to) => getMarketRate(from, to),
    });

    const adjusted = await getAdjustedRate({
      baseRate: computed.result.appliedRate,
      context: {
        txType: String(request.txType || "").toUpperCase(),
        provider: String(request.provider || "").toLowerCase(),
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
    return next(e);
  }
};
