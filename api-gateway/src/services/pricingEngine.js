"use strict";

function normStr(v) {
  const s = String(v ?? "").trim();
  return s ? s : "";
}
function upper(v) {
  return normStr(v).toUpperCase();
}

function decimalsForCurrency(code) {
  const c = upper(code);
  if (c === "XOF" || c === "XAF" || c === "JPY") return 0;
  return 2;
}
function roundMoney(amount, currency) {
  const d = decimalsForCurrency(currency);
  const p = 10 ** d;
  return Math.round((Number(amount) + Number.EPSILON) * p) / p;
}

function inRange(amount, range) {
  const a = Number(amount);
  const min = Number(range?.min ?? 0);
  const max = range?.max == null ? null : Number(range.max);
  if (!Number.isFinite(a)) return false;
  if (a < min) return false;
  if (max != null && a > max) return false;
  return true;
}

function matchesOptionalList(value, list) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!value) return false;
  const v = String(value).trim();
  return list.some((x) => String(x).trim().toUpperCase() === v.toUpperCase());
}

/**
 * Sélectionne la meilleure règle parmi une liste déjà chargée (actives)
 */
function pickBestRule(rules, req) {
  const txType = upper(req.txType);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);
  const country = req.country ? upper(req.country) : null;
  const operator = req.operator ? normStr(req.operator) : null;

  const amount = Number(req.amount);

  const candidates = (rules || []).filter((r) => {
    if (!r?.active) return false;
    if (upper(r?.scope?.txType) !== txType) return false;
    if (upper(r?.scope?.fromCurrency) !== fromCurrency) return false;
    if (upper(r?.scope?.toCurrency) !== toCurrency) return false;
    if (!inRange(amount, r?.amountRange)) return false;

    // si la règle définit countries/operators, ça doit matcher
    if (!matchesOptionalList(country, r?.scope?.countries)) return false;
    if (!matchesOptionalList(operator, r?.scope?.operators)) return false;

    return true;
  });

  // tri: priority desc puis updatedAt desc
  candidates.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    const ua = new Date(a?.updatedAt || 0).getTime();
    const ub = new Date(b?.updatedAt || 0).getTime();
    return ub - ua;
  });

  return candidates[0] || null;
}

function computeFee(amount, feeCfg, fromCurrency) {
  const mode = upper(feeCfg?.mode || "NONE");
  const percent = Number(feeCfg?.percent ?? 0);
  const fixed = Number(feeCfg?.fixed ?? 0);

  let feeRaw = 0;
  if (mode === "PERCENT") feeRaw = (Number(amount) * percent) / 100;
  else if (mode === "FIXED") feeRaw = fixed;
  else if (mode === "MIXED") feeRaw = ((Number(amount) * percent) / 100) + fixed;
  else feeRaw = 0;

  let fee = feeRaw;

  const minFee = feeCfg?.minFee == null ? null : Number(feeCfg.minFee);
  const maxFee = feeCfg?.maxFee == null ? null : Number(feeCfg.maxFee);

  if (minFee != null && fee < minFee) fee = minFee;
  if (maxFee != null && fee > maxFee) fee = maxFee;

  fee = roundMoney(fee, fromCurrency);

  return {
    fee,
    breakdown: {
      mode,
      percent,
      fixed,
      minFee,
      maxFee,
      feeRaw: roundMoney(feeRaw, fromCurrency),
    },
  };
}

/**
 * @param {object} params
 * @param {object} params.req { txType, amount, fromCurrency, toCurrency, country?, operator? }
 * @param {Array} params.rules PricingRule[] déjà chargées
 * @param {function} params.getMarketRate async (from, to) => number
 */
async function computeQuote({ req, rules, getMarketRate }) {
  const amount = Number(req.amount);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Invalid amount");
    err.status = 400;
    throw err;
  }
  if (!fromCurrency || !toCurrency) {
    const err = new Error("Missing currency");
    err.status = 400;
    throw err;
  }

  const rule = pickBestRule(rules, req);
  if (!rule) {
    const err = new Error("No pricing rule matched");
    err.status = 404;
    throw err;
  }

  // Fees
  const { fee, breakdown } = computeFee(amount, rule.fee, fromCurrency);
  const grossFrom = roundMoney(amount, fromCurrency);
  const netFrom = roundMoney(grossFrom - fee, fromCurrency);

  if (netFrom < 0) {
    const err = new Error("Fee exceeds amount");
    err.status = 400;
    throw err;
  }

  // FX rate
  const fxMode = upper(rule?.fx?.mode || "MARKET");
  let marketRate = null;
  let appliedRate = null;

  if (fxMode === "OVERRIDE") {
    appliedRate = Number(rule?.fx?.overrideRate);
    if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
      const err = new Error("Invalid overrideRate");
      err.status = 500;
      throw err;
    }
  } else {
    marketRate = await getMarketRate(fromCurrency, toCurrency);
    if (!Number.isFinite(marketRate) || marketRate <= 0) {
      const err = new Error("Market rate unavailable");
      err.status = 502;
      throw err;
    }

    if (fxMode === "MARKUP") {
      const mp = Number(rule?.fx?.markupPercent ?? 0);
      appliedRate = marketRate * (1 + mp / 100);
    } else {
      appliedRate = marketRate;
    }
  }

  // netTo
  const netToRaw = netFrom * appliedRate;
  const netTo = roundMoney(netToRaw, toCurrency);

  return {
    request: {
      txType: upper(req.txType),
      amount: grossFrom,
      fromCurrency,
      toCurrency,
      country: req.country ? upper(req.country) : null,
      operator: req.operator ? normStr(req.operator) : null,
    },
    result: {
      marketRate: marketRate == null ? null : Number(marketRate),
      appliedRate: Number(appliedRate),
      fee,
      feeBreakdown: breakdown,
      grossFrom,
      netFrom,
      netTo,
    },
    ruleApplied: {
      ruleId: rule._id,
      version: Number(rule.version ?? 1),
      priority: Number(rule.priority ?? 0),
    },
  };
}

module.exports = {
  computeQuote,
  roundMoney,
  decimalsForCurrency,
};
