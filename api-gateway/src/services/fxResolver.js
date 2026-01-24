"use strict";

function resolveFxRate(fxRates, base, quote) {
  const rate = fxRates.find(
    (r) => r.base === base && r.quote === quote
  );

  if (!rate) return null;

  const spreadFactor = 1 + (rate.spread || 0);
  return {
    rawRate: rate.rate,
    appliedRate: rate.rate * spreadFactor,
    fxRateId: rate._id,
  };
}

module.exports = { resolveFxRate };
