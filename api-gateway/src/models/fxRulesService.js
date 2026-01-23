"use strict";

const FxRule = require("../models/FxRule");

function inRange(amount, minAmount, maxAmount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return false;
  if (a < Number(minAmount || 0)) return false;
  if (maxAmount != null && Number.isFinite(Number(maxAmount)) && a > Number(maxAmount)) return false;
  return true;
}

function matchOptional(val, ruleVal) {
  // si la règle n’impose rien => match
  if (!ruleVal) return true;
  return String(val || "").trim().toLowerCase() === String(ruleVal).trim().toLowerCase();
}

function matchOptionalUpper(val, ruleVal) {
  if (!ruleVal) return true;
  return String(val || "").trim().toUpperCase() === String(ruleVal).trim().toUpperCase();
}

async function pickFxRule({ txType, provider, country, fromCurrency, toCurrency, amount }) {
  const query = {
    active: true,
    fromCurrency: String(fromCurrency).toUpperCase(),
    toCurrency: String(toCurrency).toUpperCase(),
  };

  const rules = await FxRule.find(query).sort({ priority: -1, updatedAt: -1 }).lean();

  const candidates = rules.filter((r) => {
    if (r.txType && !matchOptionalUpper(txType, r.txType)) return false;
    if (r.provider && !matchOptional(provider, r.provider)) return false;
    if (r.country && !matchOptional(country, r.country)) return false;
    if (!inRange(amount, r.minAmount, r.maxAmount)) return false;
    return true;
  });

  return candidates[0] || null;
}

function applyFxRule(baseRate, rule) {
  const b = Number(baseRate);
  if (!Number.isFinite(b) || b <= 0) return { rate: null, info: { error: "invalid_base_rate" } };
  if (!rule || rule.mode === "PASS_THROUGH") return { rate: b, info: { mode: "PASS_THROUGH" } };

  const mode = rule.mode;
  let out = b;

  if (mode === "OVERRIDE") {
    out = Number(rule.overrideRate);
  } else if (mode === "MARKUP_PERCENT") {
    out = b * (1 + Number(rule.percent || 0) / 100);
  } else if (mode === "DELTA_PERCENT") {
    out = b * (1 + Number(rule.percent || 0) / 100); // percent peut être négatif
  } else if (mode === "DELTA_ABS") {
    out = b + Number(rule.deltaAbs || 0);
  }

  if (!Number.isFinite(out) || out <= 0) {
    return { rate: null, info: { mode, error: "invalid_adjusted_rate" } };
  }

  // précision (taux)
  const rounded = Math.round(out * 1e8) / 1e8;

  return {
    rate: rounded,
    info: {
      mode,
      baseRate: b,
      adjustedRate: rounded,
      ruleId: String(rule._id),
      percent: rule.percent ?? 0,
      deltaAbs: rule.deltaAbs ?? 0,
      overrideRate: rule.overrideRate ?? null,
      priority: rule.priority ?? 0,
      name: rule.name,
    },
  };
}

async function getAdjustedRate({ baseRate, context }) {
  const rule = await pickFxRule(context);
  const applied = applyFxRule(baseRate, rule);

  // update lastUsedAt best-effort
  if (rule?._id) {
    FxRule.updateOne({ _id: rule._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  }

  return { rule: rule || null, ...applied };
}

module.exports = { getAdjustedRate };
