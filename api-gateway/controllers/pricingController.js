// "use strict";

// const { v4: uuidv4 } = require("uuid");

// const PricingRule = require("../src/models/PricingRule");
// const PricingQuote = require("../src/models/PricingQuote");

// const {
//   computeQuote,
//   roundMoney,
//   normalizeCountryISO2,
// } = require("../src/services/pricingEngine");

// const { getExchangeRate } = require("../src/services/exchangeRateService");

// const LOCK_TTL_MIN = Number(process.env.PRICING_LOCK_TTL_MIN || 10);

// function pickBody(req) {
//   return req.body && Object.keys(req.body).length ? req.body : req.query;
// }

// const normStr = (v) => String(v ?? "").trim();
// const upper = (v) => normStr(v).toUpperCase();
// const lower = (v) => normStr(v).toLowerCase();

// function normalizeTxType(v) {
//   const raw = upper(v);
//   if (!raw) return "";

//   if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

//   const low = lower(v);
//   if (["send", "transfer", "transfert"].includes(low)) return "TRANSFER";
//   if (["deposit", "cashin", "topup"].includes(low)) return "DEPOSIT";
//   if (["withdraw", "withdrawal", "cashout", "retrait"].includes(low)) return "WITHDRAW";

//   return raw;
// }

// function normalizeMethod(v) {
//   const raw = upper(v);
//   if (!raw) return "";

//   if (["MOBILEMONEY", "BANK", "CARD", "INTERNAL"].includes(raw)) return raw;

//   const low = lower(v);
//   if (["mobilemoney", "mobile_money", "mm"].includes(low)) return "MOBILEMONEY";
//   if (["bank", "wire", "transfer_bank", "virement"].includes(low)) return "BANK";
//   if (["card", "visa", "mastercard"].includes(low)) return "CARD";
//   if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

//   return raw;
// }

// function normalizeCountryForStore(country) {
//   if (!country) return null;
//   const iso2 = normalizeCountryISO2(country);
//   return upper(iso2 || country);
// }

// function pickRequestId(req) {
//   return req.get("x-request-id") || req.get("x-correlation-id") || req.get("x-amzn-trace-id") || null;
// }

// async function getMarketRateDirect(from, to, { requestId } = {}) {
//   const out = await getExchangeRate(from, to, { requestId });
//   const rate = Number(out?.rate ?? out);
//   return Number.isFinite(rate) ? rate : null;
// }

// /**
//  * ✅ Convertit un montant vers la devise admin (CAD)
//  */
// async function convertToAdminCurrency({
//   amount,
//   fromCurrency,
//   adminCurrency = "CAD",
//   requestId,
// }) {
//   const safeAmount = Number(amount || 0);
//   const from = upper(fromCurrency);
//   const admin = upper(adminCurrency);

//   if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
//     return {
//       adminCurrency: admin,
//       amountAdmin: 0,
//       conversionRate: 0,
//     };
//   }

//   if (from === admin) {
//     return {
//       adminCurrency: admin,
//       amountAdmin: roundMoney(safeAmount, admin),
//       conversionRate: 1,
//     };
//   }

//   const rate = await getMarketRateDirect(from, admin, { requestId });
//   if (!Number.isFinite(rate) || rate <= 0) {
//     return {
//       adminCurrency: admin,
//       amountAdmin: 0,
//       conversionRate: 0,
//     };
//   }

//   return {
//     adminCurrency: admin,
//     amountAdmin: roundMoney(safeAmount * rate, admin),
//     conversionRate: Number(rate),
//   };
// }

// function buildRequest(body = {}) {
//   return {
//     txType: normalizeTxType(body.txType),
//     method: normalizeMethod(body.method),
//     amount: Number(body.amount),
//     fromCurrency: upper(body.fromCurrency),
//     toCurrency: upper(body.toCurrency),

//     country: normalizeCountryForStore(body.country),
//     operator: body.operator ? lower(body.operator) : null,
//     provider: body.provider ? lower(body.provider) : null,

//     fromCountry: normalizeCountryForStore(body.fromCountry),
//     toCountry: normalizeCountryForStore(body.toCountry),
//   };
// }

// function validateRequest(request) {
//   if (!request.txType) return "txType est requis";
//   if (!request.amount || !Number.isFinite(request.amount) || request.amount <= 0) {
//     return "amount doit être un nombre > 0";
//   }
//   if (!request.fromCurrency) return "fromCurrency est requis";
//   if (!request.toCurrency) return "toCurrency est requis";
//   return null;
// }

// function buildDebugPayload({ request, quote, requestId }) {
//   const fee = Number(quote?.result?.fee || 0);
//   const grossFrom = Number(quote?.result?.grossFrom || request?.amount || 0);
//   const netFrom = Number(quote?.result?.netFrom || 0);
//   const marketRate =
//     quote?.result?.marketRate != null ? Number(quote.result.marketRate) : null;
//   const appliedRate =
//     quote?.result?.appliedRate != null ? Number(quote.result.appliedRate) : null;
//   const netTo = Number(quote?.result?.netTo || 0);

//   const feeRevenueCAD = Number(quote?.result?.feeRevenue?.amountCAD || 0);
//   const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
//   const fxRevenueCAD = Number(quote?.result?.fxRevenue?.amountCAD || 0);

//   return {
//     requestId: requestId || null,

//     requestNormalized: {
//       txType: request?.txType || null,
//       method: request?.method || null,
//       amount: Number(request?.amount || 0),
//       fromCurrency: request?.fromCurrency || null,
//       toCurrency: request?.toCurrency || null,
//       country: request?.country || null,
//       fromCountry: request?.fromCountry || null,
//       toCountry: request?.toCountry || null,
//       provider: request?.provider || null,
//       operator: request?.operator || null,
//     },

//     feeSource: fee,
//     feeComputation: {
//       grossFrom,
//       fee,
//       netFrom,
//       formula:
//         Number.isFinite(grossFrom) && Number.isFinite(fee)
//           ? `${grossFrom} - ${fee} = ${netFrom}`
//           : null,
//     },

//     feeRuleApplied: quote?.ruleApplied || null,
//     fxRuleApplied: quote?.fxRuleApplied || null,

//     feeRevenueCAD,

//     fxComputation: {
//       marketRate,
//       appliedRate,
//       spreadPerUnit:
//         Number.isFinite(marketRate) && Number.isFinite(appliedRate)
//           ? Math.max(0, marketRate - appliedRate)
//           : null,
//       marginDelta:
//         Number.isFinite(marketRate) && Number.isFinite(appliedRate)
//           ? appliedRate - marketRate
//           : null,
//       netTo,
//       fxRevenueTo,
//       fxRevenueToCurrency: quote?.result?.fxRevenue?.toCurrency || null,
//       fxRevenueCAD,
//       fxConversionRateToCAD: Number(quote?.result?.fxRevenue?.conversionRateToCAD || 0),
//       formula:
//         Number.isFinite(netFrom) && Number.isFinite(appliedRate)
//           ? `${netFrom} * ${appliedRate} = ${netTo}`
//           : null,
//       gainFormula:
//         Number.isFinite(netFrom) &&
//         Number.isFinite(marketRate) &&
//         Number.isFinite(appliedRate)
//           ? `${netFrom} * (${marketRate} - ${appliedRate}) = ${fxRevenueTo}`
//           : null,
//     },

//     feeBreakdown: quote?.result?.feeBreakdown || null,
//     feeRevenue: quote?.result?.feeRevenue || null,
//     fxRevenue: quote?.result?.fxRevenue || null,
//   };
// }

// async function computeFullQuote({ request, requestId }) {
//   const rules = await PricingRule.find({ active: true }).lean();

//   const quote = await computeQuote({
//     req: request,
//     rules,
//     getMarketRate: async (from, to) => getMarketRateDirect(from, to, { requestId }),
//   });

//   /**
//    * ✅ Revenu frais admin
//    * On convertit le montant des frais (devise source) en CAD
//    */
//   const feeRevenueAdmin = await convertToAdminCurrency({
//     amount: Number(quote?.result?.fee || 0),
//     fromCurrency: request.fromCurrency,
//     adminCurrency: "CAD",
//     requestId,
//   });

//   quote.result.feeRevenue = {
//     sourceCurrency: request.fromCurrency,
//     amount: Number(quote?.result?.fee || 0),
//     adminCurrency: feeRevenueAdmin.adminCurrency,
//     amountCAD: feeRevenueAdmin.amountAdmin,
//     conversionRateToCAD: feeRevenueAdmin.conversionRate,
//     calculatedAt: new Date().toISOString(),
//   };

//   /**
//    * ✅ Revenu FX admin
//    * On convertit le gain FX (devise cible) en CAD
//    */
//   const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
//   const fxRevenueToCurrency = quote?.result?.fxRevenue?.toCurrency || request.toCurrency;

//   const fxRevenueAdmin = await convertToAdminCurrency({
//     amount: fxRevenueTo,
//     fromCurrency: fxRevenueToCurrency,
//     adminCurrency: "CAD",
//     requestId,
//   });

//   quote.result.fxRevenue = {
//     ...(quote.result.fxRevenue || {}),
//     adminCurrency: fxRevenueAdmin.adminCurrency,
//     amountCAD: fxRevenueAdmin.amountAdmin,
//     conversionRateToCAD: fxRevenueAdmin.conversionRate,
//     calculatedAt: new Date().toISOString(),
//   };

//   quote.debug = buildDebugPayload({
//     request,
//     quote,
//     requestId,
//   });

//   return quote;
// }

// exports.quote = async (req, res, next) => {
//   try {
//     const body = pickBody(req);
//     const requestId = pickRequestId(req);

//     const request = buildRequest(body);
//     const validationError = validateRequest(request);

//     if (validationError) {
//       return res.status(400).json({
//         ok: false,
//         error: validationError,
//       });
//     }

//     const quote = await computeFullQuote({ request, requestId });

//     return res.status(200).json({
//       ok: true,
//       mode: "QUOTE",
//       request: quote.request,
//       result: quote.result,
//       feeSource: quote.debug?.feeSource ?? Number(quote?.result?.fee || 0),
//       ruleApplied: quote.ruleApplied || null,
//       fxRuleApplied: quote.fxRuleApplied || null,
//       debug: quote.debug || null,
//     });
//   } catch (e) {
//     if (e && e.status === 404 && e.details) {
//       return res.status(404).json({
//         ok: false,
//         error: e.message || "No pricing rule matched",
//         details: e.details,
//       });
//     }

//     if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
//       return res.status(503).json({
//         ok: false,
//         error: "FX rate unavailable",
//         details: e.details || null,
//       });
//     }

//     return next(e);
//   }
// };

// exports.lock = async (req, res, next) => {
//   try {
//     const userId = req.user?._id;
//     if (!userId) {
//       return res.status(401).json({
//         ok: false,
//         message: "Unauthorized",
//       });
//     }

//     const body = pickBody(req);
//     const requestId = pickRequestId(req);

//     const request = buildRequest(body);
//     const validationError = validateRequest(request);

//     if (validationError) {
//       return res.status(400).json({
//         ok: false,
//         error: validationError,
//       });
//     }

//     const computed = await computeFullQuote({ request, requestId });

//     const quoteId = uuidv4();
//     const expiresAt = new Date(Date.now() + LOCK_TTL_MIN * 60 * 1000);

//     const doc = await PricingQuote.create({
//       quoteId,
//       userId,
//       status: "ACTIVE",
//       request: {
//         txType: computed.request.txType,
//         method: computed.request.method || null,
//         amount: Number(computed.request.amount),
//         fromCurrency: upper(computed.request.fromCurrency),
//         toCurrency: upper(computed.request.toCurrency),
//         country: normalizeCountryForStore(computed.request.country),
//         fromCountry: normalizeCountryForStore(computed.request.fromCountry),
//         toCountry: normalizeCountryForStore(computed.request.toCountry),
//         operator: computed.request.operator ? lower(computed.request.operator) : null,
//         provider: computed.request.provider ? lower(computed.request.provider) : null,
//       },
//       result: computed.result,
//       ruleApplied: computed.ruleApplied || null,
//       fxRuleApplied: computed.fxRuleApplied || null,
//       debug: computed.debug || null,
//       expiresAt,
//     });

//     return res.status(200).json({
//       ok: true,
//       mode: "LOCKED",
//       quoteId: doc.quoteId,
//       expiresAt: doc.expiresAt,
//       request: doc.request,
//       result: doc.result,
//       feeSource: doc.debug?.feeSource ?? Number(doc?.result?.fee || 0),
//       ruleApplied: doc.ruleApplied || null,
//       fxRuleApplied: doc.fxRuleApplied || null,
//       debug: doc.debug || null,
//     });
//   } catch (e) {
//     if (e && e.status === 404 && e.details) {
//       return res.status(404).json({
//         ok: false,
//         error: e.message || "No pricing rule matched",
//         details: e.details,
//       });
//     }

//     if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
//       return res.status(503).json({
//         ok: false,
//         error: "FX rate unavailable",
//         details: e.details || null,
//       });
//     }

//     return next(e);
//   }
// };







"use strict";

const { v4: uuidv4 } = require("uuid");

const PricingRule = require("../src/models/PricingRule");
const PricingQuote = require("../src/models/PricingQuote");

const {
  computeQuote,
  roundMoney,
  normalizeCountryISO2,
} = require("../src/services/pricingEngine");

const { getExchangeRate } = require("../src/services/exchangeRateService");

const LOCK_TTL_MIN_RAW = Number(process.env.PRICING_LOCK_TTL_MIN || 10);
const LOCK_TTL_MIN =
  Number.isFinite(LOCK_TTL_MIN_RAW) && LOCK_TTL_MIN_RAW > 0
    ? LOCK_TTL_MIN_RAW
    : 10;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pickBody(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query || {};
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function cleanId(v) {
  const s = normStr(v);
  return s || undefined;
}

function compactObject(obj = {}) {
  const out = {};

  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }

  return out;
}

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);

  if (["send", "p2p", "transfer", "transfert"].includes(low)) {
    return "TRANSFER";
  }

  if (["deposit", "depot", "dépôt", "cashin", "topup"].includes(low)) {
    return "DEPOSIT";
  }

  if (
    ["withdraw", "withdrawal", "cashout", "retrait", "payout"].includes(low)
  ) {
    return "WITHDRAW";
  }

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v).replace(/[\s-]+/g, "_");
  if (!raw) return "";

  if (["MOBILEMONEY", "MOBILE_MONEY", "MOMO", "MM"].includes(raw)) {
    return "MOBILEMONEY";
  }

  if (["BANK", "WIRE", "TRANSFER_BANK", "VIREMENT"].includes(raw)) {
    return "BANK";
  }

  if (
    [
      "CARD",
      "VISA",
      "VISA_DIRECT",
      "MASTERCARD",
      "STRIPE",
      "CARTE",
    ].includes(raw)
  ) {
    return "CARD";
  }

  if (["INTERNAL", "WALLET", "PAYNOVAL"].includes(raw)) {
    return "INTERNAL";
  }

  return raw;
}

function normalizeCountryForStore(country) {
  if (!country) return null;

  const iso2 = normalizeCountryISO2(country);
  return upper(iso2 || country);
}

function pickRequestId(req) {
  return (
    req.get("x-request-id") ||
    req.get("x-correlation-id") ||
    req.get("x-amzn-trace-id") ||
    null
  );
}

function pickCurrency(...values) {
  for (const value of values) {
    const s = upper(value);
    if (!s) continue;

    if (s === "€" || s.includes("EUR")) return "EUR";
    if (s === "$" || s.includes("USD")) return "USD";
    if (s.includes("CAD")) return "CAD";
    if (s.includes("GBP") || s.includes("£")) return "GBP";
    if (s.includes("XOF") || s.includes("FCFA") || s.includes("CFA")) {
      return "XOF";
    }
    if (s.includes("XAF")) return "XAF";

    const letters = s.replace(/[^A-Z]/g, "");
    if (letters.length === 3) return letters;
  }

  return "";
}

async function getMarketRateDirect(from, to, { requestId } = {}) {
  if (upper(from) === upper(to)) return 1;

  const out = await getExchangeRate(from, to, { requestId });
  const rate = Number(out?.rate ?? out);

  return Number.isFinite(rate) ? rate : null;
}

/**
 * Convertit un montant vers la devise admin CAD.
 */
async function convertToAdminCurrency({
  amount,
  fromCurrency,
  adminCurrency = "CAD",
  requestId,
}) {
  const safeAmount = Number(amount || 0);
  const from = upper(fromCurrency);
  const admin = upper(adminCurrency);

  if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
    return {
      adminCurrency: admin,
      amountAdmin: 0,
      conversionRate: 0,
    };
  }

  if (from === admin) {
    return {
      adminCurrency: admin,
      amountAdmin: roundMoney(safeAmount, admin),
      conversionRate: 1,
    };
  }

  const rate = await getMarketRateDirect(from, admin, { requestId });

  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      adminCurrency: admin,
      amountAdmin: 0,
      conversionRate: 0,
    };
  }

  return {
    adminCurrency: admin,
    amountAdmin: roundMoney(safeAmount * rate, admin),
    conversionRate: Number(rate),
  };
}

function buildRequest(body = {}) {
  const txType = normalizeTxType(
    body.txType || body.transactionType || body.flow || body.type
  );

  const method = normalizeMethod(
    body.method || body.methodType || body.rail || body.paymentMethod
  );

  const amount = Number(
    body.amount ??
      body.amountSource ??
      body.grossFrom ??
      body.netFrom ??
      body.sourceAmount
  );

  const fromCurrency = pickCurrency(
    body.fromCurrency,
    body.currencySource,
    body.senderCurrencyCode,
    body.currency,
    body.sourceCurrency,
    body.selectedCurrency
  );

  const toCurrency =
    pickCurrency(
      body.toCurrency,
      body.currencyTarget,
      body.localCurrencyCode,
      body.targetCurrency,
      body.destinationCurrency,
      body.localCurrencySymbol
    ) || fromCurrency;

  return {
    txType,
    method,
    amount,
    fromCurrency,
    toCurrency,

    country: normalizeCountryForStore(
      body.country || body.destinationCountry || body.toCountry
    ),

    operator: body.operator
      ? lower(body.operator)
      : body.operatorName
      ? lower(body.operatorName)
      : body.mobileMoney
      ? lower(body.mobileMoney)
      : null,

    provider: body.provider ? lower(body.provider) : null,

    fromCountry: normalizeCountryForStore(
      body.fromCountry || body.sourceCountry
    ),

    toCountry: normalizeCountryForStore(
      body.toCountry || body.targetCountry || body.destinationCountry
    ),
  };
}

function validateRequest(request) {
  if (!request.txType) return "txType est requis";

  if (
    !request.amount ||
    !Number.isFinite(request.amount) ||
    request.amount <= 0
  ) {
    return "amount doit être un nombre > 0";
  }

  if (!request.fromCurrency) return "fromCurrency est requis";
  if (!request.toCurrency) return "toCurrency est requis";

  return null;
}

function buildPricingAliases(quoteId) {
  const id = cleanId(quoteId);

  return compactObject({
    quoteId: id,
    pricingId: id,
    pricingLockId: id,
    lockId: id,
    effectivePricingId: id,
  });
}

function buildDebugPayload({ request, quote, requestId }) {
  const fee = Number(quote?.result?.fee || 0);
  const grossFrom = Number(quote?.result?.grossFrom || request?.amount || 0);
  const netFrom = Number(quote?.result?.netFrom || 0);

  const marketRate =
    quote?.result?.marketRate != null ? Number(quote.result.marketRate) : null;

  const appliedRate =
    quote?.result?.appliedRate != null ? Number(quote.result.appliedRate) : null;

  const netTo = Number(quote?.result?.netTo || 0);

  const feeRevenueCAD = Number(quote?.result?.feeRevenue?.amountCAD || 0);
  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueCAD = Number(quote?.result?.fxRevenue?.amountCAD || 0);

  return {
    requestId: requestId || null,

    requestNormalized: {
      txType: request?.txType || null,
      method: request?.method || null,
      amount: Number(request?.amount || 0),
      fromCurrency: request?.fromCurrency || null,
      toCurrency: request?.toCurrency || null,
      country: request?.country || null,
      fromCountry: request?.fromCountry || null,
      toCountry: request?.toCountry || null,
      provider: request?.provider || null,
      operator: request?.operator || null,
    },

    feeSource: fee,

    feeComputation: {
      grossFrom,
      fee,
      netFrom,
      formula:
        Number.isFinite(grossFrom) && Number.isFinite(fee)
          ? `${grossFrom} - ${fee} = ${netFrom}`
          : null,
    },

    feeRuleApplied: quote?.ruleApplied || null,
    fxRuleApplied: quote?.fxRuleApplied || null,

    feeRevenueCAD,

    fxComputation: {
      marketRate,
      appliedRate,
      spreadPerUnit:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? Math.max(0, marketRate - appliedRate)
          : null,
      marginDelta:
        Number.isFinite(marketRate) && Number.isFinite(appliedRate)
          ? appliedRate - marketRate
          : null,
      netTo,
      fxRevenueTo,
      fxRevenueToCurrency: quote?.result?.fxRevenue?.toCurrency || null,
      fxRevenueCAD,
      fxConversionRateToCAD: Number(
        quote?.result?.fxRevenue?.conversionRateToCAD || 0
      ),
      formula:
        Number.isFinite(netFrom) && Number.isFinite(appliedRate)
          ? `${netFrom} * ${appliedRate} = ${netTo}`
          : null,
      gainFormula:
        Number.isFinite(netFrom) &&
        Number.isFinite(marketRate) &&
        Number.isFinite(appliedRate)
          ? `${netFrom} * (${marketRate} - ${appliedRate}) = ${fxRevenueTo}`
          : null,
    },

    feeBreakdown: quote?.result?.feeBreakdown || null,
    feeRevenue: quote?.result?.feeRevenue || null,
    fxRevenue: quote?.result?.fxRevenue || null,
  };
}

async function computeFullQuote({ request, requestId }) {
  const rules = await PricingRule.find({ active: true }).lean();

  const quote = await computeQuote({
    req: request,
    rules,
    getMarketRate: async (from, to) =>
      getMarketRateDirect(from, to, { requestId }),
  });

  quote.result = quote.result || {};

  const feeRevenueAdmin = await convertToAdminCurrency({
    amount: Number(quote?.result?.fee || 0),
    fromCurrency: request.fromCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.feeRevenue = {
    sourceCurrency: request.fromCurrency,
    amount: Number(quote?.result?.fee || 0),
    adminCurrency: feeRevenueAdmin.adminCurrency,
    amountCAD: feeRevenueAdmin.amountAdmin,
    conversionRateToCAD: feeRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  const fxRevenueTo = Number(quote?.result?.fxRevenue?.amount || 0);
  const fxRevenueToCurrency =
    quote?.result?.fxRevenue?.toCurrency || request.toCurrency;

  const fxRevenueAdmin = await convertToAdminCurrency({
    amount: fxRevenueTo,
    fromCurrency: fxRevenueToCurrency,
    adminCurrency: "CAD",
    requestId,
  });

  quote.result.fxRevenue = {
    ...(quote.result.fxRevenue || {}),
    adminCurrency: fxRevenueAdmin.adminCurrency,
    amountCAD: fxRevenueAdmin.amountAdmin,
    conversionRateToCAD: fxRevenueAdmin.conversionRate,
    calculatedAt: new Date().toISOString(),
  };

  quote.debug = buildDebugPayload({
    request,
    quote,
    requestId,
  });

  return quote;
}

function buildQuoteResponsePayload({ quote, mode = "QUOTE" }) {
  return {
    success: true,
    ok: true,
    mode,
    request: quote.request,
    result: quote.result,
    feeSource: quote.debug?.feeSource ?? Number(quote?.result?.fee || 0),
    ruleApplied: quote.ruleApplied || null,
    fxRuleApplied: quote.fxRuleApplied || null,
    debug: quote.debug || null,
  };
}

function buildLockResponsePayload({ doc }) {
  const aliases = buildPricingAliases(doc.quoteId);

  const base = {
    success: true,
    ok: true,
    mode: "LOCKED",

    ...aliases,

    expiresAt: doc.expiresAt,
    request: doc.request,
    result: doc.result,
    feeSource: doc.debug?.feeSource ?? Number(doc?.result?.fee || 0),
    ruleApplied: doc.ruleApplied || null,
    fxRuleApplied: doc.fxRuleApplied || null,
    debug: doc.debug || null,
  };

  return {
    ...base,

    /**
     * Compat front :
     * - axios normalizeResponse peut retourner {...data}
     * - certains appels lisent lockRes.data
     * - d'autres lisent lockRes.data.data
     */
    data: {
      ...base,
    },
  };
}

function sendPricingError(res, status, message, details = null) {
  return res.status(status).json({
    success: false,
    ok: false,
    error: message,
    message,
    details,
  });
}

/* -------------------------------------------------------------------------- */
/* Controllers                                                                 */
/* -------------------------------------------------------------------------- */

exports.quote = async (req, res, next) => {
  try {
    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = buildRequest(body);
    const validationError = validateRequest(request);

    if (validationError) {
      return sendPricingError(res, 400, validationError);
    }

    const quote = await computeFullQuote({ request, requestId });

    return res.status(200).json(buildQuoteResponsePayload({ quote }));
  } catch (e) {
    if (e && e.status === 404 && e.details) {
      return sendPricingError(
        res,
        404,
        e.message || "No pricing rule matched",
        e.details
      );
    }

    if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
      return sendPricingError(
        res,
        503,
        "FX rate unavailable",
        e.details || null
      );
    }

    return next(e);
  }
};

exports.lock = async (req, res, next) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return sendPricingError(res, 401, "Unauthorized");
    }

    const body = pickBody(req);
    const requestId = pickRequestId(req);

    const request = buildRequest(body);
    const validationError = validateRequest(request);

    if (validationError) {
      return sendPricingError(res, 400, validationError);
    }

    const computed = await computeFullQuote({ request, requestId });

    const quoteId = uuidv4();
    const expiresAt = new Date(Date.now() + LOCK_TTL_MIN * 60 * 1000);

    const doc = await PricingQuote.create({
      quoteId,
      userId,
      status: "ACTIVE",
      request: {
        txType: computed.request.txType,
        method: computed.request.method || null,
        amount: Number(computed.request.amount),
        fromCurrency: upper(computed.request.fromCurrency),
        toCurrency: upper(computed.request.toCurrency),
        country: normalizeCountryForStore(computed.request.country),
        fromCountry: normalizeCountryForStore(computed.request.fromCountry),
        toCountry: normalizeCountryForStore(computed.request.toCountry),
        operator: computed.request.operator
          ? lower(computed.request.operator)
          : null,
        provider: computed.request.provider
          ? lower(computed.request.provider)
          : null,
      },
      result: computed.result,
      ruleApplied: computed.ruleApplied || null,
      fxRuleApplied: computed.fxRuleApplied || null,
      debug: computed.debug || null,
      expiresAt,
    });

    return res.status(200).json(buildLockResponsePayload({ doc }));
  } catch (e) {
    if (e && e.status === 404 && e.details) {
      return sendPricingError(
        res,
        404,
        e.message || "No pricing rule matched",
        e.details
      );
    }

    if (e && (e.status === 503 || e.message === "FX rate unavailable")) {
      return sendPricingError(
        res,
        503,
        "FX rate unavailable",
        e.details || null
      );
    }

    return next(e);
  }
};