"use strict";

/**
 * Plus c’est spécifique → plus c’est prioritaire
 */
function scoreRule(rule, ctx) {
  let score = rule.priority || 0;

  if (rule.country && rule.country === ctx.country) score += 20;
  if (rule.operator && rule.operator === ctx.operator) score += 20;
  if (rule.toCurrency && rule.toCurrency === ctx.toCurrency) score += 10;

  return score;
}

function selectBestFeeRule(fees, ctx) {
  const candidates = fees.filter((f) => {
    if (f.scope !== ctx.scope) return false;
    if (f.fromCurrency !== ctx.fromCurrency) return false;
    if (f.toCurrency && f.toCurrency !== ctx.toCurrency) return false;
    if (f.country && f.country !== ctx.country) return false;
    if (f.operator && f.operator !== ctx.operator) return false;
    return true;
  });

  if (!candidates.length) return null;

  return candidates
    .map((rule) => ({ rule, score: scoreRule(rule, ctx) }))
    .sort((a, b) => b.score - a.score)[0].rule;
}

module.exports = { selectBestFeeRule };
