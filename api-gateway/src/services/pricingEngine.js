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
 * - accepte "france", "FR", "fr", "Côte d'Ivoire", etc.
 */
const COUNTRY_ALIASES_TO_ISO2 = {
  // FR
  FRANCE: "FR",
  FRENCH: "FR",
  FR: "FR",

  // CI
  "COTE D'IVOIRE": "CI",
  "COTE D IVOIRE": "CI",
  "CÔTE D'IVOIRE": "CI",
  "CÔTE D IVOIRE": "CI",
  "IVORY COAST": "CI",
  CIV: "CI",
  CI: "CI",

  // BF
  "BURKINA FASO": "BF",
  BF: "BF",

  // ML
  MALI: "ML",
  ML: "ML",

  // SN
  SENEGAL: "SN",
  "SÉNÉGAL": "SN",
  SN: "SN",

  // CM
  CAMEROUN: "CM",
  CAMEROON: "CM",
  CM: "CM",

  // CA
  CANADA: "CA",
  CA: "CA",

  // US
  USA: "US",
  "UNITED STATES": "US",
  "ETATS UNIS": "US",
  "ÉTATS UNIS": "US",
  US: "US",

  // BE
  BELGIQUE: "BE",
  BELGIUM: "BE",
  BE: "BE",

  // DE
  ALLEMAGNE: "DE",
  GERMANY: "DE",
  DE: "DE",
};

function normalizeCountryISO2(v) {
  const raw0 = stripAccents(v);
  const raw = upper(raw0);
  if (!raw) return null;

  // ISO2
  if (/^[A-Z]{2}$/.test(raw)) return raw;

  // ISO3 minimal
  if (raw === "CIV") return "CI";

  const mapped = COUNTRY_ALIASES_TO_ISO2[raw];
  if (mapped) return mapped;

  // nettoyage ponctuation
  const cleaned = raw.replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return COUNTRY_ALIASES_TO_ISO2[cleaned] || null;
}

/**
 * Tokens possibles pour matcher countries
 * ex "france" => ["FR","FRANCE"]
 * ex "fr" => ["FR","FR"]
 */
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

/**
 * ✅ match list optionnelle (case-insensitive + accents-safe)
 */
function matchesOptionalList(value, list) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!value) return false;

  const v = upper(stripAccents(value));
  return list.some((x) => upper(stripAccents(x)) === v);
}

/**
 * ✅ match countries robuste :
 * - ruleCountries ex ["FR","CI"] (ou même ["fr"])
 * - reqCountry peut être "france"
 */
function matchesCountries(reqCountry, ruleCountries) {
  if (!Array.isArray(ruleCountries) || ruleCountries.length === 0) return true;

  const tokens = countryTokens(reqCountry);
  if (!tokens.length) return false;

  // match si au moins un token match un item
  return tokens.some((t) => matchesOptionalList(t, ruleCountries));
}

/**
 * Sélectionne la meilleure règle (priority desc puis updatedAt desc)
 */
function pickBestRule(rules, req) {
  const txType = normalizeTxType(req.txType);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  const reqCountryRaw = req.country ? String(req.country) : null;

  // operator: on normalise pour matcher rule.scope.operators
  const operator =
    req.operator != null && String(req.operator).trim()
      ? upper(stripAccents(req.operator))
      : null;

  const amount = Number(req.amount);

  const candidates = (rules || []).filter((r) => {
    if (!r?.active) return false;

    // txType strict
    if (upper(r?.scope?.txType) !== txType) return false;

    // currencies strict
    if (upper(r?.scope?.fromCurrency) !== fromCurrency) return false;
    if (upper(r?.scope?.toCurrency) !== toCurrency) return false;

    // range
    if (!inRange(amount, r?.amountRange)) return false;

    // countries/operators optionnels
    if (!matchesCountries(reqCountryRaw, r?.scope?.countries)) return false;
    if (!matchesOptionalList(operator, r?.scope?.operators)) return false;

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
 * @param {object} params
 * @param {object} params.req { txType, amount, fromCurrency, toCurrency, country?, operator? }
 * @param {Array} params.rules PricingRule[] déjà chargées
 * @param {function} params.getMarketRate async (from, to) => number
 */
async function computeQuote({ req, rules, getMarketRate }) {
  const amount = Number(req.amount);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  const txType = normalizeTxType(req.txType);

  // ✅ important: on normalise en ISO2 pour matcher rules ["FR","CI"...]
  const countryISO2 = req.country ? normalizeCountryISO2(req.country) : null;

  const operator =
    req.operator != null && String(req.operator).trim()
      ? upper(stripAccents(req.operator))
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
    country: countryISO2 || req.country,
    operator,
  });

  if (!rule) {
    const err = new Error("No pricing rule matched");
    err.status = 404;
    err.details = {
      normalizedRequest: {
        txType,
        amount,
        fromCurrency,
        toCurrency,
        // on renvoie iso2 si possible (sinon raw upper)
        country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
        operator: operator || null,
      },
      rulesLoaded: Array.isArray(rules) ? rules.length : 0,
      hint:
        "Crée une PricingRule ACTIVE pour (txType, fromCurrency, toCurrency) + range, et mets scope.countries vide (globale) OU contient FR/CI/... (ISO2).",
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
      txType,
      amount: grossFrom,
      fromCurrency,
      toCurrency,
      country: countryISO2 || (req.country ? upper(stripAccents(req.country)) : null),
      operator: operator || null,
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
  normalizeTxType,
  normalizeCountryISO2,
};
