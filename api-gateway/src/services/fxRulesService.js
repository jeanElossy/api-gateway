// File: src/services/fxRulesService.js
"use strict";

const FxRule = require("../models/FxRule");

function toUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function toLower(v) {
  return String(v || "").trim().toLowerCase();
}

function isEmpty(v) {
  return !String(v || "").trim();
}

function inRange(amount, minAmount, maxAmount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return false;

  const min = Number(minAmount || 0);
  const max = maxAmount == null ? null : Number(maxAmount);

  if (a < min) return false;
  if (max != null && Number.isFinite(max) && a > max) return false;

  return true;
}

function matchOptionalLower(val, ruleVal) {
  if (isEmpty(ruleVal)) return true;
  return toLower(val) === toLower(ruleVal);
}

function matchOptionalUpper(val, ruleVal) {
  if (isEmpty(ruleVal)) return true;
  return toUpper(val) === toUpper(ruleVal);
}

function computeSpecificityScore(rule, ctx) {
  let score = 0;

  if (!isEmpty(rule.txType) && matchOptionalUpper(ctx.txType, rule.txType)) score += 50;
  if (!isEmpty(rule.method) && matchOptionalUpper(ctx.method, rule.method)) score += 45;
  if (!isEmpty(rule.provider) && matchOptionalLower(ctx.provider, rule.provider)) score += 40;

  if (!isEmpty(rule.country) && matchOptionalLower(ctx.country, rule.country)) score += 30;
  if (!isEmpty(rule.fromCountry) && matchOptionalLower(ctx.fromCountry, rule.fromCountry)) score += 35;
  if (!isEmpty(rule.toCountry) && matchOptionalLower(ctx.toCountry, rule.toCountry)) score += 35;

  if (!isEmpty(rule.fromCurrency) && matchOptionalUpper(ctx.fromCurrency, rule.fromCurrency)) score += 25;
  if (!isEmpty(rule.toCurrency) && matchOptionalUpper(ctx.toCurrency, rule.toCurrency)) score += 25;

  if (rule.minAmount != null) score += 5;
  if (rule.maxAmount != null) score += 5;

  return score;
}

async function pickFxRule(ctx) {
  const query = {
    active: true,
    fromCurrency: toUpper(ctx.fromCurrency),
    toCurrency: toUpper(ctx.toCurrency),
  };

  const rules = await FxRule.find(query).lean();

  const candidates = rules
    .filter((r) => {
      if (!matchOptionalUpper(ctx.txType, r.txType)) return false;
      if (!matchOptionalUpper(ctx.method, r.method)) return false;
      if (!matchOptionalLower(ctx.provider, r.provider)) return false;
      if (!matchOptionalLower(ctx.country, r.country)) return false;
      if (!matchOptionalLower(ctx.fromCountry, r.fromCountry)) return false;
      if (!matchOptionalLower(ctx.toCountry, r.toCountry)) return false;
      if (!inRange(ctx.amount, r.minAmount, r.maxAmount)) return false;
      return true;
    })
    .map((r) => ({
      rule: r,
      specificity: computeSpecificityScore(r, ctx),
      priority: Number(r.priority || 0),
      updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
      minAmount: Number(r.minAmount || 0),
    }))
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.minAmount !== a.minAmount) return b.minAmount - a.minAmount;
      return b.updatedAt - a.updatedAt;
    });

  return candidates[0]?.rule || null;
}

function applyFxRule(baseRate, rule) {
  const b = Number(baseRate);

  if (!Number.isFinite(b) || b <= 0) {
    return {
      rate: null,
      info: { error: "invalid_base_rate" },
    };
  }

  if (!rule || rule.mode === "PASS_THROUGH") {
    return {
      rate: b,
      info: {
        mode: "PASS_THROUGH",
        baseRate: b,
        adjustedRate: b,
      },
    };
  }

  const mode = String(rule.mode || "").toUpperCase();
  let out = b;

  if (mode === "OVERRIDE") {
    out = Number(rule.overrideRate);
  } else if (mode === "MARKUP_PERCENT") {
    out = b * (1 + Number(rule.markupPercent || 0) / 100);
  } else if (mode === "DELTA_PERCENT") {
    out = b * (1 + Number(rule.percent || 0) / 100);
  } else if (mode === "DELTA_ABS") {
    out = b + Number(rule.deltaAbs || 0);
  }

  if (!Number.isFinite(out) || out <= 0) {
    return {
      rate: null,
      info: {
        mode,
        error: "invalid_adjusted_rate",
      },
    };
  }

  const rounded = Math.round(out * 1e8) / 1e8;

  return {
    rate: rounded,
    info: {
      mode,
      baseRate: b,
      adjustedRate: rounded,
      ruleId: String(rule._id),
      name: rule.name || "",
      priority: Number(rule.priority || 0),
      percent: Number(rule.percent || 0),
      markupPercent: Number(rule.markupPercent || 0),
      deltaAbs: Number(rule.deltaAbs || 0),
      overrideRate: rule.overrideRate ?? null,
      txType: rule.txType || "",
      method: rule.method || "",
      provider: rule.provider || "",
      country: rule.country || "",
      fromCountry: rule.fromCountry || "",
      toCountry: rule.toCountry || "",
      fromCurrency: rule.fromCurrency || "",
      toCurrency: rule.toCurrency || "",
    },
  };
}

async function getAdjustedRate({ baseRate, context }) {
  const ctx = context || {};
  const rule = await pickFxRule(ctx);
  const applied = applyFxRule(baseRate, rule);

  if (rule?._id) {
    FxRule.updateOne(
      { _id: rule._id },
      { $set: { lastUsedAt: new Date() } }
    ).catch(() => {});
  }

  return { rule: rule || null, ...applied };
}

module.exports = { getAdjustedRate };