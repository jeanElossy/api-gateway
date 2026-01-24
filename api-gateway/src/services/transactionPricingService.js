"use strict";

const { feeCache, fxCache } = require("./configSyncService");
const { selectBestFeeRule } = require("./feeSelector");
const { computeFee } = require("./feeCalculator");
const { resolveFxRate } = require("./fxResolver");

async function priceTransaction(ctx) {
  const fees = feeCache.get("ALL");
  const fxRates = fxCache.get("ALL");

  if (!fees || !fxRates) {
    throw new Error("Pricing configs not loaded");
  }

  const feeRule = selectBestFeeRule(fees, ctx);
  if (!feeRule) {
    throw new Error("No fee rule found");
  }

  const fx =
    ctx.fromCurrency !== ctx.toCurrency
      ? resolveFxRate(fxRates, ctx.fromCurrency, ctx.toCurrency)
      : null;

  const fee = computeFee(ctx.amount, feeRule);

  return {
    fee,
    feeRuleId: feeRule._id,
    fxRate: fx?.appliedRate || 1,
    fxRateId: fx?.fxRateId || null,
  };
}

module.exports = { priceTransaction };
