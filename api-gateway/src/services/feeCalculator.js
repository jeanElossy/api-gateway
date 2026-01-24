"use strict";

function computeFee(amount, rule) {
  let fee = 0;

  switch (rule.feeType) {
    case "PERCENT":
      fee = amount * (rule.feeValue / 100);
      break;

    case "FIXED":
      fee = rule.fixedFee;
      break;

    case "MIXED":
      fee =
        amount * (rule.feeValue / 100) +
        rule.fixedFee;
      break;
  }

  if (rule.minFee != null) fee = Math.max(fee, rule.minFee);
  if (rule.maxFee != null) fee = Math.min(fee, rule.maxFee);

  return Math.round(fee);
}

module.exports = { computeFee };
