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

async function pickFxRule(ctx) {
  const query = {
    active: true,
    fromCurrency: toUpper(ctx.fromCurrency),
    toCurrency: toUpper(ctx.toCurrency),
  };

  const rules = await FxRule.find(query).sort({ priority: -1, updatedAt: -1 }).lean();

  const candidates = rules.filter((r) => {
    if (!matchOptionalUpper(ctx.txType, r.txType)) return false;
    if (!matchOptionalLower(ctx.provider, r.provider)) return false;
    if (!matchOptionalLower(ctx.country, r.country)) return false;
    if (!inRange(ctx.amount, r.minAmount, r.maxAmount)) return false;
    return true;
  });

  return candidates[0] || null;
}

function applyFxRule(baseRate, rule) {
  const b = Number(baseRate);
  if (!Number.isFinite(b) || b <= 0) {
    return { rate: null, info: { error: "invalid_base_rate" } };
  }

  if (!rule || rule.mode === "PASS_THROUGH") {
    return { rate: b, info: { mode: "PASS_THROUGH", baseRate: b } };
  }

  const mode = rule.mode;
  let out = b;

  if (mode === "OVERRIDE") {
    out = Number(rule.overrideRate);
  } else if (mode === "DELTA_PERCENT") {
    out = b * (1 + Number(rule.percent || 0) / 100);
  } else if (mode === "DELTA_ABS") {
    out = b + Number(rule.deltaAbs || 0);
  }

  if (!Number.isFinite(out) || out <= 0) {
    return { rate: null, info: { mode, error: "invalid_adjusted_rate" } };
  }

  // précision de taux
  const rounded = Math.round(out * 1e8) / 1e8;

  return {
    rate: rounded,
    info: {
      mode,
      baseRate: b,
      adjustedRate: rounded,
      ruleId: String(rule._id),
      name: rule.name,
      priority: Number(rule.priority || 0),
      percent: Number(rule.percent || 0),
      deltaAbs: Number(rule.deltaAbs || 0),
      overrideRate: rule.overrideRate ?? null,
    },
  };
}

async function getAdjustedRate({ baseRate, context }) {
  const rule = await pickFxRule(context || {});
  const applied = applyFxRule(baseRate, rule);

  if (rule?._id) {
    FxRule.updateOne({ _id: rule._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  }

  return { rule: rule || null, ...applied };
}

module.exports = { getAdjustedRate };
