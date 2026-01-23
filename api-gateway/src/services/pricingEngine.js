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
 * - accepte TRANSFER/DEPOSIT/WITHDRAW (officiel)
 * - accepte send/withdraw/deposit (mobile / legacy)
 */
function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  // already valid
  if (raw === "TRANSFER" || raw === "DEPOSIT" || raw === "WITHDRAW") return raw;

  // aliases
  const low = lower(v);
  if (low === "send" || low === "p2p" || low === "transfer" || low === "transfert") return "TRANSFER";
  if (low === "deposit" || low === "topup" || low === "cashin") return "DEPOSIT";
  if (low === "withdraw" || low === "withdrawal" || low === "cashout") return "WITHDRAW";

  return raw;
}

/**
 * ✅ Country normalization (ISO2 preferred)
 * Ton app envoie parfois "france" ou "cote d'ivoire".
 * Tes rules utilisent souvent ["FR","CI",...]
 */
const COUNTRY_ALIASES_TO_ISO2 = {
  // FR
  "FRANCE": "FR",
  "FRENCH": "FR",
  "FR": "FR",

  // CI
  "COTE D'IVOIRE": "CI",
  "COTE D IVOIRE": "CI",
  "CÔTE D'IVOIRE": "CI",
  "CÔTE D IVOIRE": "CI",
  "IVORY COAST": "CI",
  "CIV": "CI",
  "CI": "CI",

  // BF
  "BURKINA FASO": "BF",
  "BF": "BF",

  // ML
  "MALI": "ML",
  "ML": "ML",

  // SN
  "SENEGAL": "SN",
  "SÉNÉGAL": "SN",
  "SN": "SN",

  // CM
  "CAMEROUN": "CM",
  "CAMEROON": "CM",
  "CM": "CM",

  // CA
  "CANADA": "CA",
  "CA": "CA",

  // US
  "USA": "US",
  "UNITED STATES": "US",
  "ETATS UNIS": "US",
  "ÉTATS UNIS": "US",
  "US": "US",

  // BE
  "BELGIQUE": "BE",
  "BELGIUM": "BE",
  "BE": "BE",

  // DE
  "ALLEMAGNE": "DE",
  "GERMANY": "DE",
  "DE": "DE",
};

function normalizeCountryISO2(v) {
  const raw = upper(stripAccents(v));
  if (!raw) return null;

  // si déjà ISO2
  if (/^[A-Z]{2}$/.test(raw)) return raw;

  // si ISO3 -> on essaie mapping minimal
  if (raw === "CIV") return "CI";

  const mapped = COUNTRY_ALIASES_TO_ISO2[raw];
  if (mapped) return mapped;

  // tentative: enlever ponctuation
  const cleaned = raw.replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return COUNTRY_ALIASES_TO_ISO2[cleaned] || cleaned || null;
}

/**
 * Retourne une liste de tokens pays possibles pour matcher:
 * ex "france" => ["FR", "FRANCE"]
 * ex "CI" => ["CI", "COTE D'IVOIRE", ...] (on garde iso + raw)
 */
function countryTokens(v) {
  const rawUp = upper(stripAccents(v));
  const iso2 = normalizeCountryISO2(v);

  const tokens = [];
  if (iso2) tokens.push(iso2);
  if (rawUp) tokens.push(rawUp);

  // unique
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
 * ✅ match list optionnelle :
 * - si list vide => ok
 * - sinon, match si value == un des items (case-insensitive)
 */
function matchesOptionalList(value, list) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!value) return false;

  const v = String(value).trim().toUpperCase();
  return list.some((x) => String(x).trim().toUpperCase() === v);
}

/**
 * ✅ match countries robuste :
 * - la règle contient souvent ["FR","CI"]
 * - la requête peut contenir "france" => tokens ["FR","FRANCE"]
 */
function matchesCountries(reqCountry, ruleCountries) {
  if (!Array.isArray(ruleCountries) || ruleCountries.length === 0) return true;

  const tokens = countryTokens(reqCountry);
  if (!tokens.length) return false;

  // match si au moins un token match un item
  return tokens.some((t) => matchesOptionalList(t, ruleCountries));
}

/**
 * Sélectionne la meilleure règle parmi une liste déjà chargée (actives)
 */
function pickBestRule(rules, req) {
  const txType = normalizeTxType(req.txType);
  const fromCurrency = upper(req.fromCurrency);
  const toCurrency = upper(req.toCurrency);

  // ✅ country normalisé en ISO2, mais on garde raw tokens pour matcher
  const reqCountryRaw = req.country ? String(req.country) : null;
  const operator = req.operator ? normStr(req.operator) : null;

  const amount = Number(req.amount);

  const candidates = (rules || []).filter((r) => {
    if (!r?.active) return false;

    // txType strict (mais on normalise la req)
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
  const countryISO2 = req.country ? normalizeCountryISO2(req.country) : null;
  const operator = req.operator ? normStr(req.operator) : null;

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

  const rule = pickBestRule(rules, { ...req, txType, country: countryISO2 || req.country, operator });
  if (!rule) {
    // ✅ debug utile : montre ce qui a été normalisé
    const err = new Error("No pricing rule matched");
    err.status = 404;
    err.details = {
      normalizedRequest: {
        txType,
        amount,
        fromCurrency,
        toCurrency,
        country: countryISO2 || (req.country ? upper(req.country) : null),
        operator: operator || null,
      },
      hint:
        "Vérifie que tu as une PricingRule active pour ce corridor + txType, et que scope.countries contient ISO2 (FR/CI/...) ou laisse countries vide.",
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
      country: countryISO2 || (req.country ? upper(req.country) : null),
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
};
