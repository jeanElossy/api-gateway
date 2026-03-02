"use strict";

function normStr(v) {
  const s = String(v ?? "").trim();
  return s ? s : "";
}

function upper(v) {
  return normStr(v).toUpperCase();
}

function lower(v) {
  return normStr(v).toLowerCase();
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * ✅ Normalisation txType robuste
 */
function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (raw === "TRANSFER" || raw === "DEPOSIT" || raw === "WITHDRAW") return raw;

  const low = lower(v);
  if (low === "send" || low === "p2p" || low === "transfer" || low === "transfert")
    return "TRANSFER";
  if (low === "deposit" || low === "topup" || low === "cashin") return "DEPOSIT";
  if (low === "withdraw" || low === "withdrawal" || low === "cashout") return "WITHDRAW";

  return raw;
}

/**
 * ✅ Country normalization (ISO2 preferred)
 */
const COUNTRY_ALIASES_TO_ISO2 = {
  FRANCE: "FR",
  FRENCH: "FR",
  FR: "FR",

  "COTE D'IVOIRE": "CI",
  "COTE D IVOIRE": "CI",
  "CÔTE D'IVOIRE": "CI",
  "CÔTE D IVOIRE": "CI",
  "IVORY COAST": "CI",
  CIV: "CI",
  CI: "CI",

  "BURKINA FASO": "BF",
  BF: "BF",

  MALI: "ML",
  ML: "ML",

  SENEGAL: "SN",
  "SÉNÉGAL": "SN",
  SN: "SN",

  CAMEROUN: "CM",
  CAMEROON: "CM",
  CM: "CM",

  CANADA: "CA",
  CA: "CA",

  USA: "US",
  "UNITED STATES": "US",
  "ETATS UNIS": "US",
  "ÉTATS UNIS": "US",
  US: "US",

  BELGIQUE: "BE",
  BELGIUM: "BE",
  BE: "BE",

  ALLEMAGNE: "DE",
  GERMANY: "DE",
  DE: "DE",
};

function normalizeCountryISO2(v) {
  const raw0 = stripAccents(v);
  const raw = upper(raw0);
  if (!raw) return null;

  if (/^[A-Z]{2}$/.test(raw)) return raw;
  if (raw === "CIV") return "CI";

  const mapped = COUNTRY_ALIASES_TO_ISO2[raw];
  if (mapped) return mapped;

  const cleaned = raw.replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return COUNTRY_ALIASES_TO_ISO2[cleaned] || null;
}

function countryTokens(v) {
  const rawUp = upper(stripAccents(v));
  const iso2 = normalizeCountryISO2(v);

  const tokens = [];
  if (iso2) tokens.push(iso2);
  if (rawUp) tokens.push(rawUp);

  return Array.from(new Set(tokens.filter(Boolean)));
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

  const v = upper(stripAccents(value));
  return list.some((x) => upper(stripAccents(x)) === v);
}

function matchesCountries(reqCountry, ruleCountries) {
  if (!Array.isArray(ruleCountries) || ruleCountries.length === 0) return true;

  const tokens = countryTokens(reqCountry);
  if (!tokens.length) return false;

  return tokens.some((t) => matchesOptionalList(t, ruleCountries));
}

/**
 * Match scope principal PricingRule
 */
function matchesScopeField(reqValue, ruleValue) {
  const r = upper(ruleValue || "ALL");
  if (!r || r === "ALL" || r === "*") return true;
  return upper(reqValue) === r;
}

function matchesScopeProvider(reqValue, ruleValue) {
  const r = lower(ruleValue || "all");
  if (!r || r === "all" || r === "*") return true;
  return lower(reqValue) === r;
}

function pickBestRule(rules, req) {
  const txType = normalizeTxType(req.txType);
  const method = upper(req.method || "");
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);
  const provider = lower(req.provider || "");

  const reqCountryRaw = req.country ? String(req.country) : null;
  const reqFromCountryRaw = req.fromCountry ? String(req.fromCountry) : null;
  const reqToCountryRaw = req.toCountry ? String(req.toCountry) : null;

  const operator =
    req.operator != null && String(req.operator).trim()
      ? lower(stripAccents(req.operator))
      : null;

  const amount = Number(req.amount);

  const candidates = (rules || []).filter((r) => {
    if (!r?.active) return false;

    const scope = r?.scope || {};

    if (!matchesScopeField(txType, scope.txType)) return false;
    if (!matchesScopeField(method, scope.method)) return false;
    if (!matchesScopeProvider(provider, scope.provider)) return false;

    if (!matchesScopeField(fromCurrency, scope.fromCurrency)) return false;
    if (!matchesScopeField(toCurrency, scope.toCurrency)) return false;

    if (scope.country && upper(scope.country) !== "ALL") {
      const iso = normalizeCountryISO2(reqCountryRaw || "");
      if (!iso || upper(scope.country) !== upper(iso)) return false;
    }

    if (scope.fromCountry && upper(scope.fromCountry) !== "ALL") {
      const iso = normalizeCountryISO2(reqFromCountryRaw || "");
      if (!iso || upper(scope.fromCountry) !== upper(iso)) return false;
    }

    if (scope.toCountry && upper(scope.toCountry) !== "ALL") {
      const iso = normalizeCountryISO2(reqToCountryRaw || "");
      if (!iso || upper(scope.toCountry) !== upper(iso)) return false;
    }

    if (!inRange(amount, r?.amountRange)) return false;

    if (!matchesCountries(reqCountryRaw, r?.countries)) return false;

    if (Array.isArray(r?.operators) && r.operators.length > 0) {
      if (!operator) return false;
      const operatorMatched = r.operators.some(
        (x) => lower(stripAccents(x)) === operator
      );
      if (!operatorMatched) return false;
    }

    return true;
  });

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
  else if (mode === "MIXED") feeRaw = (Number(amount) * percent) / 100 + fixed;
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
 * Fallback peg XOF/EUR
 */
function pegRate(from, to) {
  const PEG_XOF_PER_EUR = Number(process.env.PEG_XOF_PER_EUR || 655.957);

  const f = upper(from);
  const t = upper(to);

  if (!Number.isFinite(PEG_XOF_PER_EUR) || PEG_XOF_PER_EUR <= 0) return null;

  if (f === "XOF" && t === "EUR") return 1 / PEG_XOF_PER_EUR;
  if (f === "EUR" && t === "XOF") return PEG_XOF_PER_EUR;

  return null;
}

/**
 * ✅ Applique la logique FX de PricingRule
 * IMPORTANT:
 * - le taux est exprimé en "toCurrency par 1 fromCurrency"
 * - donc une marge plateforme = taux moins favorable au client
 */
function applyPricingRuleFx({ marketRate, fxCfg }) {
  const base = Number(marketRate);
  const mode = upper(fxCfg?.mode || "PASS_THROUGH");

  if (!Number.isFinite(base) || base <= 0) {
    const err = new Error("Invalid marketRate");
    err.status = 500;
    throw err;
  }

  if (mode === "PASS_THROUGH") {
    return {
      appliedRate: base,
      fxRuleApplied: {
        mode: "PASS_THROUGH",
        baseRate: base,
        adjustedRate: base,
      },
    };
  }

  if (mode === "OVERRIDE") {
    const out = Number(fxCfg?.overrideRate);
    if (!Number.isFinite(out) || out <= 0) {
      const err = new Error("Invalid overrideRate");
      err.status = 500;
      throw err;
    }
    return {
      appliedRate: out,
      fxRuleApplied: {
        mode: "OVERRIDE",
        baseRate: base,
        adjustedRate: out,
        overrideRate: out,
      },
    };
  }

  if (mode === "MARKUP_PERCENT") {
    const mp = Number(fxCfg?.markupPercent ?? 0);
    const out = base * (1 - mp / 100);

    if (!Number.isFinite(out) || out <= 0) {
      const err = new Error("Invalid markup-adjusted rate");
      err.status = 500;
      throw err;
    }

    return {
      appliedRate: out,
      fxRuleApplied: {
        mode: "MARKUP_PERCENT",
        baseRate: base,
        adjustedRate: out,
        markupPercent: mp,
        strategy: "PLATFORM_GAIN_REDUCES_CLIENT_RATE",
      },
    };
  }

  if (mode === "DELTA_PERCENT") {
    const pct = Number(fxCfg?.percent ?? 0);
    const out = base * (1 + pct / 100);

    if (!Number.isFinite(out) || out <= 0) {
      const err = new Error("Invalid delta-percent-adjusted rate");
      err.status = 500;
      throw err;
    }

    return {
      appliedRate: out,
      fxRuleApplied: {
        mode: "DELTA_PERCENT",
        baseRate: base,
        adjustedRate: out,
        percent: pct,
      },
    };
  }

  if (mode === "DELTA_ABS") {
    const deltaAbs = Number(fxCfg?.deltaAbs ?? 0);
    const out = base + deltaAbs;

    if (!Number.isFinite(out) || out <= 0) {
      const err = new Error("Invalid delta-abs-adjusted rate");
      err.status = 500;
      throw err;
    }

    return {
      appliedRate: out,
      fxRuleApplied: {
        mode: "DELTA_ABS",
        baseRate: base,
        adjustedRate: out,
        deltaAbs,
      },
    };
  }

  return {
    appliedRate: base,
    fxRuleApplied: {
      mode: "PASS_THROUGH",
      baseRate: base,
      adjustedRate: base,
      fallbackFromUnknownMode: mode,
    },
  };
}

/**
 * @param {object} params
 * @param {object} params.req
 * @param {Array} params.rules
 * @param {function} params.getMarketRate
 */
async function computeQuote({ req, rules, getMarketRate }) {
  const amount = Number(req.amount);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  const txType = normalizeTxType(req.txType);
  const method = upper(req.method || "");

  const countryISO2 = req.country ? normalizeCountryISO2(req.country) : null;
  const fromCountryISO2 = req.fromCountry ? normalizeCountryISO2(req.fromCountry) : null;
  const toCountryISO2 = req.toCountry ? normalizeCountryISO2(req.toCountry) : null;

  const operator =
    req.operator != null && String(req.operator).trim()
      ? lower(stripAccents(req.operator))
      : null;

  const provider =
    req.provider != null && String(req.provider).trim()
      ? lower(req.provider)
      : null;

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
  if (!txType) {
    const err = new Error("Missing txType");
    err.status = 400;
    throw err;
  }

  const rule = pickBestRule(rules, {
    ...req,
    txType,
    method,
    provider,
    country: countryISO2 || req.country,
    fromCountry: fromCountryISO2 || req.fromCountry,
    toCountry: toCountryISO2 || req.toCountry,
    operator,
  });

  if (!rule) {
    const err = new Error("No pricing rule matched");
    err.status = 404;
    err.details = {
      normalizedRequest: {
        txType,
        method,
        amount,
        fromCurrency,
        toCurrency,
        country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
        fromCountry:
          fromCountryISO2 || (req.fromCountry ? upper(stripAccents(req.fromCountry)) : null),
        toCountry:
          toCountryISO2 || (req.toCountry ? upper(stripAccents(req.toCountry)) : null),
        provider: provider || null,
        operator: operator || null,
      },
      rulesLoaded: Array.isArray(rules) ? rules.length : 0,
      hint:
        "Crée une PricingRule ACTIVE avec scope adapté (txType, method, fromCurrency, toCurrency, corridor/provider) + range.",
    };
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

  // FX
  let marketRate = await getMarketRate(fromCurrency, toCurrency);

  if (!Number.isFinite(marketRate) || marketRate <= 0) {
    const peg = pegRate(fromCurrency, toCurrency);
    if (Number.isFinite(peg) && peg > 0) marketRate = peg;
  }

  if (!Number.isFinite(marketRate) || marketRate <= 0) {
    const err = new Error("FX rate unavailable");
    err.status = 503;
    err.details = { fromCurrency, toCurrency };
    throw err;
  }

  const { appliedRate, fxRuleApplied } = applyPricingRuleFx({
    marketRate,
    fxCfg: rule.fx,
  });

  const netToRaw = netFrom * appliedRate;
  const netTo = roundMoney(netToRaw, toCurrency);

  return {
    request: {
      txType,
      method: method || null,
      amount: grossFrom,
      fromCurrency,
      toCurrency,
      country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
      fromCountry:
        fromCountryISO2 || (req.fromCountry ? upper(stripAccents(req.fromCountry)) : null),
      toCountry:
        toCountryISO2 || (req.toCountry ? upper(stripAccents(req.toCountry)) : null),
      provider: provider || null,
      operator: operator || null,
    },
    result: {
      marketRate: Number(marketRate),
      appliedRate: Number(appliedRate),
      fee,
      feeBreakdown: breakdown,
      grossFrom,
      netFrom,
      netTo,
      fxRevenue: roundMoney(netFrom * (Number(marketRate) - Number(appliedRate)), toCurrency),
    },
    ruleApplied: {
      ruleId: rule._id,
      version: Number(rule.version ?? 1),
      priority: Number(rule.priority ?? 0),
    },
    fxRuleApplied,
  };
}

module.exports = {
  computeQuote,
  roundMoney,
  decimalsForCurrency,
  normalizeTxType,
  normalizeCountryISO2,
};