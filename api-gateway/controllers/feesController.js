// // File: src/controllers/feesController.js
// "use strict";

// const Fee = require("../src/models/Fee");
// const { getExchangeRate } = require("../src/services/exchangeRateService");
// const { normalizeCurrency } = require("../src/utils/currency");
// const { getAdjustedRate } = require("../src/services/fxRulesService");

// let logger = null;
// try {
//   logger = require("../src/logger");
// } catch (e) {
//   logger = console;
// }


// function decimalsForCurrency(code) {
//   const c = String(code || "").toUpperCase();
//   if (c === "XOF" || c === "XAF" || c === "JPY") return 0;
//   return 2;
// }

// function roundMoney(amount, currency) {
//   const d = decimalsForCurrency(currency);
//   const p = 10 ** d;
//   return Math.round((Number(amount) + Number.EPSILON) * p) / p;
// }

// const normStr = (v) => String(v ?? "").trim();
// const upper = (v) => normStr(v).toUpperCase();
// const lower = (v) => normStr(v).toLowerCase();

// function normalizeTxType(v) {
//   const raw = upper(v);
//   if (!raw) return "";

//   if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

//   const low = lower(v);
//   if (["transfer", "transfert", "send"].includes(low)) return "TRANSFER";
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
//   if (["bank", "wire", "virement"].includes(low)) return "BANK";
//   if (["card", "visa", "mastercard"].includes(low)) return "CARD";
//   if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

//   return raw;
// }

// function toBool(v, defaultValue = undefined) {
//   if (v === undefined || v === null || v === "") return defaultValue;
//   if (typeof v === "boolean") return v;
//   const s = String(v).trim().toLowerCase();
//   if (["true", "1", "yes", "y", "on"].includes(s)) return true;
//   if (["false", "0", "no", "n", "off"].includes(s)) return false;
//   return defaultValue;
// }

// function toNumber(v, defaultValue = undefined) {
//   if (v === undefined || v === null || v === "") return defaultValue;
//   const n = Number(String(v).replace(",", "."));
//   return Number.isFinite(n) ? n : defaultValue;
// }

// // ✅ frais + ajustements admin (extraPercent/extraFixed)
// function computeFeeFromBareme(feeDoc, amountNum, feeCurrency) {
//   if (!feeDoc) return { fee: 0, feePercent: 0, breakdown: null };

//   const extraPercent = Number(feeDoc.extraPercent || 0);
//   const extraFixed = Number(feeDoc.extraFixed || 0);

//   let feeValue = 0;
//   let feePercent = 0;

//   if (feeDoc.type === "fixed") {
//     feeValue = Number(feeDoc.amount || 0) + extraFixed;
//     feePercent = 0;
//   } else if (feeDoc.type === "percent") {
//     const basePercent = Number(feeDoc.amount || 0);
//     feePercent = basePercent + extraPercent;

//     let rawFee = (amountNum * basePercent) / 100;
//     rawFee += (amountNum * extraPercent) / 100;
//     rawFee += extraFixed;

//     if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
//     if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

//     feeValue = rawFee;
//   }

//   if (!Number.isFinite(feeValue) || feeValue < 0) feeValue = 0;

//   feeValue = roundMoney(feeValue, feeCurrency);

//   return {
//     fee: feeValue,
//     feePercent,
//     breakdown: {
//       feeId: feeDoc._id,
//       name: feeDoc.name || "",
//       slug: feeDoc.slug || "",
//       txType: feeDoc.txType || "",
//       method: feeDoc.method || "",
//       provider: feeDoc.provider || "",
//       country: feeDoc.country || "",
//       toCountry: feeDoc.toCountry || "",
//       currency: feeDoc.currency || "",
//       toCurrency: feeDoc.toCurrency || "",
//       type: feeDoc.type,
//       baseAmount: Number(feeDoc.amount || 0),
//       extraPercent,
//       extraFixed,
//       minFee: feeDoc.minFee ?? null,
//       maxFee: feeDoc.maxFee ?? null,
//       minAmount: feeDoc.minAmount ?? 0,
//       maxAmount: feeDoc.maxAmount ?? null,
//       priority: feeDoc.priority ?? 0,
//     },
//   };
// }

// function buildFeeMatchQuery({
//   txType = "",
//   method = "",
//   provider = "",
//   country = "",
//   toCountry = "",
//   currency = "",
//   toCurrency = "",
//   amountNum = 0,
// }) {
//   const query = {
//     active: true,
//     currency,
//     minAmount: { $lte: amountNum },
//     $and: [
//       {
//         $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: null }, { maxAmount: { $exists: false } }],
//       },
//     ],
//   };

//   // ✅ champs optionnels = exact si fournis, sinon on laisse règle globale ("")
//   query.$and.push({
//     $or: [{ txType }, { txType: "" }],
//   });

//   query.$and.push({
//     $or: [{ method }, { method: "" }],
//   });

//   query.$and.push({
//     $or: [{ provider }, { provider: "" }],
//   });

//   query.$and.push({
//     $or: [{ country }, { country: "" }],
//   });

//   query.$and.push({
//     $or: [{ toCountry }, { toCountry: "" }],
//   });

//   query.$and.push({
//     $or: [{ toCurrency }, { toCurrency: "" }],
//   });

//   return query;
// }

// function computeSpecificityScore(feeDoc, ctx) {
//   let score = 0;

//   if (feeDoc.txType && feeDoc.txType === ctx.txType) score += 50;
//   if (feeDoc.method && feeDoc.method === ctx.method) score += 40;
//   if (feeDoc.provider && feeDoc.provider === ctx.provider) score += 35;
//   if (feeDoc.country && feeDoc.country === ctx.country) score += 30;
//   if (feeDoc.toCountry && feeDoc.toCountry === ctx.toCountry) score += 30;
//   if (feeDoc.currency && feeDoc.currency === ctx.currency) score += 25;
//   if (feeDoc.toCurrency && feeDoc.toCurrency === ctx.toCurrency) score += 25;

//   if (feeDoc.minAmount != null) score += 5;
//   if (feeDoc.maxAmount != null) score += 5;

//   return score;
// }

// async function pickBestFeeRule(ctx) {
//   const query = buildFeeMatchQuery(ctx);

//   const candidates = await Fee.find(query).lean();
//   if (!candidates.length) return null;

//   const ranked = candidates
//     .map((doc) => ({
//       doc,
//       specificity: computeSpecificityScore(doc, ctx),
//       priority: Number(doc.priority || 0),
//       minAmount: Number(doc.minAmount || 0),
//       updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0,
//     }))
//     .sort((a, b) => {
//       if (b.specificity !== a.specificity) return b.specificity - a.specificity;
//       if (b.priority !== a.priority) return b.priority - a.priority;
//       if (b.minAmount !== a.minAmount) return b.minAmount - a.minAmount;
//       return b.updatedAt - a.updatedAt;
//     });

//   return ranked[0]?.doc || null;
// }

// exports.getFees = async (req, res) => {
//   try {
//     const query = {};

//     if (req.query.q && String(req.query.q).trim()) {
//       const regex = new RegExp(String(req.query.q).trim(), "i");
//       query.$or = [
//         { name: regex },
//         { description: regex },
//         { provider: regex },
//         { country: regex },
//         { toCountry: regex },
//         { currency: regex },
//         { toCurrency: regex },
//       ];
//     }

//     if (req.query.txType) query.txType = normalizeTxType(req.query.txType);
//     if (req.query.method) query.method = normalizeMethod(req.query.method);
//     if (req.query.provider !== undefined) query.provider = lower(req.query.provider);
//     if (req.query.country !== undefined) query.country = lower(req.query.country);
//     if (req.query.toCountry !== undefined) query.toCountry = lower(req.query.toCountry);
//     if (req.query.currency !== undefined) query.currency = upper(req.query.currency);
//     if (req.query.toCurrency !== undefined) query.toCurrency = upper(req.query.toCurrency);
//     if (req.query.type !== undefined) query.type = lower(req.query.type);

//     const activeParsed = toBool(req.query.active, undefined);
//     if (activeParsed !== undefined) query.active = activeParsed;

//     if (req.query.minAmount !== undefined && req.query.minAmount !== "") {
//       query.minAmount = { $gte: Number(req.query.minAmount) };
//     }

//     if (req.query.maxAmount !== undefined && req.query.maxAmount !== "") {
//       query.maxAmount = {
//         ...(query.maxAmount || {}),
//         $lte: Number(req.query.maxAmount),
//       };
//     }

//     const limit = parseInt(req.query.limit, 10) || 100;
//     const skip = parseInt(req.query.skip, 10) || 0;

//     const [fees, total] = await Promise.all([
//       Fee.find(query).sort({ priority: -1, updatedAt: -1 }).skip(skip).limit(limit),
//       Fee.countDocuments(query),
//     ]);

//     res.json({ success: true, data: fees, total });
//   } catch (e) {
//     logger.error?.("[Fees] getFees error", e);
//     res.status(500).json({ success: false, message: e.message });
//   }
// };

// exports.getFeeById = async (req, res) => {
//   try {
//     const fee = await Fee.findById(req.params.id);
//     if (!fee) {
//       return res.status(404).json({ success: false, message: "Fee introuvable" });
//     }
//     res.json({ success: true, data: fee });
//   } catch (e) {
//     logger.error?.("[Fees] getFeeById error", e);
//     res.status(500).json({ success: false, message: e.message });
//   }
// };

// exports.createFee = async (req, res) => {
//   try {
//     const payload = {
//       ...req.body,
//       txType: normalizeTxType(req.body.txType || ""),
//       method: normalizeMethod(req.body.method || ""),
//       provider: lower(req.body.provider || ""),
//       country: lower(req.body.country || ""),
//       toCountry: lower(req.body.toCountry || ""),
//       currency: upper(req.body.currency || "XOF"),
//       toCurrency: upper(req.body.toCurrency || ""),
//     };

//     const fee = new Fee(payload);
//     await fee.save();

//     res.status(201).json({ success: true, data: fee });
//   } catch (e) {
//     logger.error?.("[Fees] createFee error", e);
//     res.status(400).json({ success: false, message: e.message });
//   }
// };

// exports.updateFee = async (req, res) => {
//   try {
//     const payload = {
//       ...req.body,
//     };

//     if (payload.txType !== undefined) payload.txType = normalizeTxType(payload.txType || "");
//     if (payload.method !== undefined) payload.method = normalizeMethod(payload.method || "");
//     if (payload.provider !== undefined) payload.provider = lower(payload.provider || "");
//     if (payload.country !== undefined) payload.country = lower(payload.country || "");
//     if (payload.toCountry !== undefined) payload.toCountry = lower(payload.toCountry || "");
//     if (payload.currency !== undefined) payload.currency = upper(payload.currency || "XOF");
//     if (payload.toCurrency !== undefined) payload.toCurrency = upper(payload.toCurrency || "");

//     const fee = await Fee.findByIdAndUpdate(req.params.id, payload, {
//       new: true,
//       runValidators: true,
//     });

//     if (!fee) {
//       return res.status(404).json({ success: false, message: "Fee introuvable" });
//     }

//     res.json({ success: true, data: fee });
//   } catch (e) {
//     logger.error?.("[Fees] updateFee error", e);
//     res.status(400).json({ success: false, message: e.message });
//   }
// };

// exports.deleteFee = async (req, res) => {
//   try {
//     const fee = await Fee.findByIdAndDelete(req.params.id);
//     if (!fee) {
//       return res.status(404).json({ success: false, message: "Fee introuvable" });
//     }
//     res.json({ success: true, message: "Fee supprimée" });
//   } catch (e) {
//     logger.error?.("[Fees] deleteFee error", e);
//     res.status(500).json({ success: false, message: e.message });
//   }
// };

// exports.simulateFee = async (req, res) => {
//   try {
//     let {
//       type = "",       // compat ancien param
//       txType = "",     // nouveau param recommandé
//       method = "",
//       provider = "",
//       amount,
//       fromCurrency,
//       toCurrency,
//       currency,        // alias
//       country = "",
//       toCountry = "",
//     } = req.query;

//     const normalizedTxType = normalizeTxType(txType || type || "");
//     const normalizedMethod = normalizeMethod(method || "");
//     const normalizedProvider = lower(provider || "");
//     const normalizedCountry = lower(country || "");
//     const normalizedToCountry = lower(toCountry || "");

//     const fromCur = normalizeCurrency(fromCurrency || currency || "");
//     const toCur = normalizeCurrency(toCurrency || fromCur || "");

//     if (!amount || !fromCur) {
//       return res.status(400).json({
//         success: false,
//         message: "Paramètres requis : amount, currency/fromCurrency",
//       });
//     }

//     const amountNum = toNumber(amount);
//     if (!Number.isFinite(amountNum) || amountNum <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Montant invalide",
//       });
//     }

//     const ctx = {
//       txType: normalizedTxType,
//       method: normalizedMethod,
//       provider: normalizedProvider,
//       country: normalizedCountry,
//       toCountry: normalizedToCountry,
//       currency: fromCur,
//       toCurrency: toCur,
//       amountNum,
//     };

//     // ✅ cas annulation
//     if (lower(type) === "cancellation") {
//       const match = await pickBestFeeRule({
//         ...ctx,
//         txType: "",
//         method: "",
//       });

//       let feeValue = 0;
//       let feeType = "fixed";
//       let feeId = null;
//       let usedBareme = null;

//       if (match) {
//         const resFee = computeFeeFromBareme(match, amountNum, fromCur);
//         feeValue = resFee.fee;
//         feeType = match.type;
//         feeId = match._id;
//         usedBareme = match;

//         await Fee.updateOne({ _id: match._id }, { $set: { lastUsedAt: new Date() } });
//       } else {
//         if (["USD", "CAD", "EUR"].includes(fromCur)) feeValue = 2.99;
//         else if (["XOF", "XAF"].includes(fromCur)) feeValue = 300;
//         else feeValue = 2;
//       }

//       return res.json({
//         success: true,
//         data: {
//           fee: feeValue,
//           feeType,
//           feeId,
//           amount: amountNum,
//           currency: fromCur,
//           provider: normalizedProvider,
//           country: normalizedCountry,
//           toCountry: normalizedToCountry,
//           snapshot: usedBareme || null,
//         },
//       });
//     }

//     // ✅ sélection intelligente de la meilleure règle
//     const bareme = await pickBestFeeRule(ctx);

//     let fees = 0;
//     let feePercent = 0;
//     let usedBareme = null;
//     let feeBreakdown = null;

//     if (bareme) {
//       const resFee = computeFeeFromBareme(bareme, amountNum, fromCur);
//       fees = resFee.fee;
//       feePercent = resFee.feePercent;
//       feeBreakdown = resFee.breakdown;
//       usedBareme = bareme;

//       await Fee.updateOne({ _id: bareme._id }, { $set: { lastUsedAt: new Date() } });
//     } else {
//       // fallback
//       let pct = 0.01;
//       if (normalizedProvider === "stripe" || normalizedProvider === "bank") pct = 0.015;
//       fees = roundMoney(amountNum * pct, fromCur);
//       feePercent = pct * 100;
//       feeBreakdown = { fallback: true, pct: feePercent };
//     }

//     const netAfterFees = roundMoney(amountNum - fees, fromCur);

//     // ✅ FX marché
//     const fx = await getExchangeRate(fromCur, toCur);
//     const baseRate = Number(fx?.rate ?? fx);

//     if (fx?.retryAfterSec) {
//       res.setHeader("Retry-After", String(fx.retryAfterSec));
//     }

//     if (!Number.isFinite(baseRate) || baseRate <= 0) {
//       return res.status(503).json({
//         success: false,
//         message: "Taux de change indisponible",
//       });
//     }

//     // ✅ FX ajusté via admin rules
//     const adjusted = await getAdjustedRate({
//       baseRate,
//       context: {
//         txType: normalizedTxType,
//         method: normalizedMethod,
//         provider: normalizedProvider,
//         country: normalizedCountry,
//         fromCountry: normalizedCountry,
//         toCountry: normalizedToCountry,
//         fromCurrency: fromCur,
//         toCurrency: toCur,
//         amount: amountNum,
//       },
//     });

//     const appliedRate = Number(adjusted?.rate ?? baseRate);
//     if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
//       return res.status(503).json({
//         success: false,
//         message: "Taux ajusté invalide",
//       });
//     }

//     const convertedAmount = roundMoney(amountNum * appliedRate, toCur);
//     const convertedNet = roundMoney(netAfterFees * appliedRate, toCur);

//     return res.json({
//       success: true,
//       data: {
//         txType: normalizedTxType || null,
//         method: normalizedMethod || null,
//         provider: normalizedProvider || null,
//         country: normalizedCountry || null,
//         toCountry: normalizedToCountry || null,

//         amount: amountNum,
//         fromCurrency: fromCur,
//         toCurrency: toCur,

//         // FX
//         fxBaseRate: baseRate,
//         exchangeRate: appliedRate,
//         fxRuleApplied: adjusted?.info || null,
//         fxSource: fx?.source,
//         fxStale: !!fx?.stale,
//         fxWarning: fx?.warning,

//         // Fees
//         feePercent,
//         fees,
//         feeBreakdown,
//         netAfterFees,

//         // Converted
//         convertedAmount,
//         convertedNetAfterFees: convertedNet,

//         // règle choisie
//         baremeId: usedBareme ? usedBareme._id : null,
//         baremeSnapshot: usedBareme || null,
//       },
//     });
//   } catch (e) {
//     logger.error?.("[Fees] simulateFee error", e);

//     const msg = String(e?.message || "");
//     const status =
//       e?.status ||
//       (msg.toLowerCase().includes("taux") || msg.toLowerCase().includes("fx") ? 503 : 500);

//     if (e?.debug?.blocked?.retryAfterSec) {
//       res.setHeader("Retry-After", String(e.debug.blocked.retryAfterSec));
//     }

//     return res.status(status).json({
//       success: false,
//       message: e.message,
//     });
//   }
// };




"use strict";

const Fee = require("../src/models/Fee");
const { getExchangeRate } = require("../src/services/exchangeRateService");
const { normalizeCurrency } = require("../src/utils/currency");
const { getAdjustedRate } = require("../src/services/fxRulesService");

let logger = null;
try {
  logger = require("../src/logger");
} catch (e) {
  logger = console;
}

function decimalsForCurrency(code) {
  const c = String(code || "").toUpperCase();
  if (c === "XOF" || c === "XAF" || c === "JPY") return 0;
  return 2;
}

function roundMoney(amount, currency) {
  const d = decimalsForCurrency(currency);
  const p = 10 ** d;
  return Math.round((Number(amount) + Number.EPSILON) * p) / p;
}

const normStr = (v) => String(v ?? "").trim();
const upper = (v) => normStr(v).toUpperCase();
const lower = (v) => normStr(v).toLowerCase();

function normalizeTxType(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["TRANSFER", "DEPOSIT", "WITHDRAW"].includes(raw)) return raw;

  const low = lower(v);
  if (["transfer", "transfert", "send"].includes(low)) return "TRANSFER";
  if (["deposit", "cashin", "topup"].includes(low)) return "DEPOSIT";
  if (["withdraw", "withdrawal", "cashout", "retrait"].includes(low)) return "WITHDRAW";

  return raw;
}

function normalizeMethod(v) {
  const raw = upper(v);
  if (!raw) return "";

  if (["MOBILEMONEY", "BANK", "CARD", "INTERNAL"].includes(raw)) return raw;

  const low = lower(v);
  if (["mobilemoney", "mobile_money", "mm"].includes(low)) return "MOBILEMONEY";
  if (["bank", "wire", "virement"].includes(low)) return "BANK";
  if (["card", "visa", "mastercard"].includes(low)) return "CARD";
  if (["internal", "wallet", "paynoval"].includes(low)) return "INTERNAL";

  return raw;
}

function normalizeFeeType(v) {
  const t = lower(v || "");
  if (["fixed", "forfait", "fixe"].includes(t)) return "fixed";
  if (["percent", "percentage", "pourcentage"].includes(t)) return "percent";
  if (["mixed", "mixte", "hybrid", "hybride"].includes(t)) return "mixed";
  return t;
}

function toBool(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

function toNumber(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : defaultValue;
}

function safeDateMs(v) {
  const ts = new Date(v).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

// ✅ frais + ajustements admin (extraPercent/extraFixed)
// ✅ supporte fixed / percent / mixed
function computeFeeFromBareme(feeDoc, amountNum, feeCurrency) {
  if (!feeDoc) return { fee: 0, feePercent: 0, breakdown: null };

  const feeType = normalizeFeeType(feeDoc.type);
  const baseAmount = Number(feeDoc.amount || 0);
  const extraPercent = Number(feeDoc.extraPercent || 0);
  const extraFixed = Number(feeDoc.extraFixed || 0);

  let feeValue = 0;
  let feePercent = 0;

  if (feeType === "fixed") {
    feeValue = baseAmount + extraFixed;
    feePercent = 0;
  } else if (feeType === "percent") {
    feePercent = baseAmount + extraPercent;

    let rawFee = (amountNum * baseAmount) / 100;
    rawFee += (amountNum * extraPercent) / 100;
    rawFee += extraFixed;

    if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = rawFee;
  } else if (feeType === "mixed") {
    // Convention retenue :
    // - feeDoc.amount = % de base
    // - feeDoc.fixedAmount = partie fixe dédiée si elle existe
    // - sinon extraFixed sert de partie fixe
    const fixedPart = Number(
      feeDoc.fixedAmount ??
      feeDoc.fixed ??
      feeDoc.flatAmount ??
      0
    );

    feePercent = baseAmount + extraPercent;

    let rawFee = (amountNum * baseAmount) / 100;
    rawFee += (amountNum * extraPercent) / 100;
    rawFee += fixedPart + extraFixed;

    if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = rawFee;
  }

  if (!Number.isFinite(feeValue) || feeValue < 0) feeValue = 0;

  feeValue = roundMoney(feeValue, feeCurrency);

  return {
    fee: feeValue,
    feePercent,
    breakdown: {
      feeId: feeDoc._id,
      name: feeDoc.name || "",
      slug: feeDoc.slug || "",
      txType: feeDoc.txType || "",
      method: feeDoc.method || "",
      provider: feeDoc.provider || "",
      country: feeDoc.country || "",
      toCountry: feeDoc.toCountry || "",
      currency: feeDoc.currency || "",
      toCurrency: feeDoc.toCurrency || "",
      type: feeType,
      baseAmount,
      fixedAmount: Number(
        feeDoc.fixedAmount ??
        feeDoc.fixed ??
        feeDoc.flatAmount ??
        0
      ),
      extraPercent,
      extraFixed,
      minFee: feeDoc.minFee ?? null,
      maxFee: feeDoc.maxFee ?? null,
      minAmount: feeDoc.minAmount ?? 0,
      maxAmount: feeDoc.maxAmount ?? null,
      priority: feeDoc.priority ?? 0,
      formula:
        feeType === "fixed"
          ? `fixed(${baseAmount}) + extraFixed(${extraFixed})`
          : feeType === "percent"
          ? `(${amountNum} * (${baseAmount}% + ${extraPercent}%)) + ${extraFixed}`
          : `(${amountNum} * (${baseAmount}% + ${extraPercent}%)) + fixed(${Number(
              feeDoc.fixedAmount ?? feeDoc.fixed ?? feeDoc.flatAmount ?? 0
            )}) + extraFixed(${extraFixed})`,
    },
  };
}

function buildFeeMatchQuery({
  txType = "",
  method = "",
  provider = "",
  country = "",
  toCountry = "",
  currency = "",
  toCurrency = "",
  amountNum = 0,
}) {
  const query = {
    active: true,
    currency,
    minAmount: { $lte: amountNum },
    $and: [
      {
        $or: [
          { maxAmount: { $gte: amountNum } },
          { maxAmount: null },
          { maxAmount: { $exists: false } },
        ],
      },
    ],
  };

  // ✅ champs optionnels = exact si fournis, sinon règle globale ""
  query.$and.push({
    $or: [{ txType }, { txType: "" }],
  });

  query.$and.push({
    $or: [{ method }, { method: "" }],
  });

  query.$and.push({
    $or: [{ provider }, { provider: "" }],
  });

  query.$and.push({
    $or: [{ country }, { country: "" }],
  });

  query.$and.push({
    $or: [{ toCountry }, { toCountry: "" }],
  });

  query.$and.push({
    $or: [{ toCurrency }, { toCurrency: "" }],
  });

  return query;
}

function computeSpecificityScore(feeDoc, ctx) {
  let score = 0;

  if (feeDoc.txType && feeDoc.txType === ctx.txType) score += 50;
  if (feeDoc.method && feeDoc.method === ctx.method) score += 40;
  if (feeDoc.provider && feeDoc.provider === ctx.provider) score += 35;
  if (feeDoc.country && feeDoc.country === ctx.country) score += 30;
  if (feeDoc.toCountry && feeDoc.toCountry === ctx.toCountry) score += 30;
  if (feeDoc.currency && feeDoc.currency === ctx.currency) score += 25;
  if (feeDoc.toCurrency && feeDoc.toCurrency === ctx.toCurrency) score += 25;

  if (feeDoc.minAmount != null) score += 5;
  if (feeDoc.maxAmount != null) score += 5;

  return score;
}

async function pickBestFeeRule(ctx) {
  const query = buildFeeMatchQuery(ctx);
  const candidates = await Fee.find(query).lean();
  if (!candidates.length) return null;

  const ranked = candidates
    .map((doc) => ({
      doc,
      specificity: computeSpecificityScore(doc, ctx),
      priority: Number(doc.priority || 0),
      minAmount: Number(doc.minAmount || 0),
      updatedAt: safeDateMs(doc.updatedAt),
    }))
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.minAmount !== a.minAmount) return b.minAmount - a.minAmount;
      return b.updatedAt - a.updatedAt;
    });

  return ranked[0]?.doc || null;
}

function buildSimulationDebug({
  ctx,
  amountNum,
  fromCur,
  toCur,
  bareme,
  feeBreakdown,
  fees,
  netAfterFees,
  fx,
  baseRate,
  adjusted,
  appliedRate,
  convertedAmount,
  convertedNet,
}) {
  return {
    requestNormalized: {
      txType: ctx.txType || null,
      method: ctx.method || null,
      provider: ctx.provider || null,
      country: ctx.country || null,
      toCountry: ctx.toCountry || null,
      amount: amountNum,
      fromCurrency: fromCur,
      toCurrency: toCur,
    },

    feeSource: fees,
    feeRuleApplied: bareme || null,
    feeBreakdown: feeBreakdown || null,

    feeCalculation: {
      grossFrom: amountNum,
      fee: fees,
      netAfterFees,
      formula:
        Number.isFinite(amountNum) && Number.isFinite(fees)
          ? `${amountNum} - ${fees} = ${netAfterFees}`
          : null,
    },

    fxRuleApplied: adjusted?.info || null,
    fxCalculation: {
      baseRate,
      appliedRate,
      convertedAmount,
      convertedNetAfterFees: convertedNet,
      source: fx?.source || null,
      stale: !!fx?.stale,
      warning: fx?.warning || null,
    },
  };
}

exports.getFees = async (req, res) => {
  try {
    const query = {};

    if (req.query.q && String(req.query.q).trim()) {
      const regex = new RegExp(String(req.query.q).trim(), "i");
      query.$or = [
        { name: regex },
        { description: regex },
        { provider: regex },
        { country: regex },
        { toCountry: regex },
        { currency: regex },
        { toCurrency: regex },
      ];
    }

    if (req.query.txType) query.txType = normalizeTxType(req.query.txType);
    if (req.query.method) query.method = normalizeMethod(req.query.method);
    if (req.query.provider !== undefined) query.provider = lower(req.query.provider);
    if (req.query.country !== undefined) query.country = lower(req.query.country);
    if (req.query.toCountry !== undefined) query.toCountry = lower(req.query.toCountry);
    if (req.query.currency !== undefined) query.currency = upper(req.query.currency);
    if (req.query.toCurrency !== undefined) query.toCurrency = upper(req.query.toCurrency);
    if (req.query.type !== undefined) query.type = normalizeFeeType(req.query.type);

    const activeParsed = toBool(req.query.active, undefined);
    if (activeParsed !== undefined) query.active = activeParsed;

    if (req.query.minAmount !== undefined && req.query.minAmount !== "") {
      query.minAmount = { $gte: Number(req.query.minAmount) };
    }

    if (req.query.maxAmount !== undefined && req.query.maxAmount !== "") {
      query.maxAmount = {
        ...(query.maxAmount || {}),
        $lte: Number(req.query.maxAmount),
      };
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [fees, total] = await Promise.all([
      Fee.find(query).sort({ priority: -1, updatedAt: -1 }).skip(skip).limit(limit),
      Fee.countDocuments(query),
    ]);

    res.json({ success: true, data: fees, total });
  } catch (e) {
    logger.error?.("[Fees] getFees error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getFeeById = async (req, res) => {
  try {
    const fee = await Fee.findById(req.params.id);
    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] getFeeById error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.createFee = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      txType: normalizeTxType(req.body.txType || ""),
      method: normalizeMethod(req.body.method || ""),
      provider: lower(req.body.provider || ""),
      country: lower(req.body.country || ""),
      toCountry: lower(req.body.toCountry || ""),
      currency: upper(req.body.currency || "XOF"),
      toCurrency: upper(req.body.toCurrency || ""),
      type: normalizeFeeType(req.body.type || ""),
    };

    const fee = new Fee(payload);
    await fee.save();

    res.status(201).json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] createFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.updateFee = async (req, res) => {
  try {
    const payload = {
      ...req.body,
    };

    if (payload.txType !== undefined) payload.txType = normalizeTxType(payload.txType || "");
    if (payload.method !== undefined) payload.method = normalizeMethod(payload.method || "");
    if (payload.provider !== undefined) payload.provider = lower(payload.provider || "");
    if (payload.country !== undefined) payload.country = lower(payload.country || "");
    if (payload.toCountry !== undefined) payload.toCountry = lower(payload.toCountry || "");
    if (payload.currency !== undefined) payload.currency = upper(payload.currency || "XOF");
    if (payload.toCurrency !== undefined) payload.toCurrency = upper(payload.toCurrency || "");
    if (payload.type !== undefined) payload.type = normalizeFeeType(payload.type || "");

    const fee = await Fee.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }

    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] updateFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.deleteFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndDelete(req.params.id);
    if (!fee) {
      return res.status(404).json({ success: false, message: "Fee introuvable" });
    }
    res.json({ success: true, message: "Fee supprimée" });
  } catch (e) {
    logger.error?.("[Fees] deleteFee error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.simulateFee = async (req, res) => {
  try {
    let {
      type = "",       // compat ancien param
      txType = "",     // nouveau param recommandé
      method = "",
      provider = "",
      amount,
      fromCurrency,
      toCurrency,
      currency,        // alias
      country = "",
      toCountry = "",
    } = req.query;

    const normalizedTxType = normalizeTxType(txType || type || "");
    const normalizedMethod = normalizeMethod(method || "");
    const normalizedProvider = lower(provider || "");
    const normalizedCountry = lower(country || "");
    const normalizedToCountry = lower(toCountry || "");

    const fromCur = normalizeCurrency(fromCurrency || currency || "");
    const toCur = normalizeCurrency(toCurrency || fromCur || "");

    if (!amount || !fromCur) {
      return res.status(400).json({
        success: false,
        message: "Paramètres requis : amount, currency/fromCurrency",
      });
    }

    const amountNum = toNumber(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        message: "Montant invalide",
      });
    }

    const ctx = {
      txType: normalizedTxType,
      method: normalizedMethod,
      provider: normalizedProvider,
      country: normalizedCountry,
      toCountry: normalizedToCountry,
      currency: fromCur,
      toCurrency: toCur,
      amountNum,
    };

    // ✅ cas annulation
    if (lower(type) === "cancellation") {
      const match = await pickBestFeeRule({
        ...ctx,
        txType: "",
        method: "",
      });

      let feeValue = 0;
      let feeType = "fixed";
      let feeId = null;
      let usedBareme = null;
      let feeBreakdown = null;

      if (match) {
        const resFee = computeFeeFromBareme(match, amountNum, fromCur);
        feeValue = resFee.fee;
        feeType = normalizeFeeType(match.type);
        feeId = match._id;
        usedBareme = match;
        feeBreakdown = resFee.breakdown;

        await Fee.updateOne({ _id: match._id }, { $set: { lastUsedAt: new Date() } });
      } else {
        if (["USD", "CAD", "EUR"].includes(fromCur)) feeValue = 2.99;
        else if (["XOF", "XAF"].includes(fromCur)) feeValue = 300;
        else feeValue = 2;
      }

      return res.json({
        success: true,
        data: {
          fee: feeValue,
          feeSource: feeValue,
          feeType,
          feeId,
          amount: amountNum,
          currency: fromCur,
          provider: normalizedProvider,
          country: normalizedCountry,
          toCountry: normalizedToCountry,
          snapshot: usedBareme || null,
          debug: {
            requestNormalized: {
              type: lower(type) || null,
              txType: null,
              method: null,
              provider: normalizedProvider || null,
              country: normalizedCountry || null,
              toCountry: normalizedToCountry || null,
              amount: amountNum,
              currency: fromCur,
            },
            feeRuleApplied: usedBareme || null,
            feeBreakdown: feeBreakdown || null,
            feeSource: feeValue,
          },
        },
      });
    }

    // ✅ sélection intelligente de la meilleure règle
    const bareme = await pickBestFeeRule(ctx);

    let fees = 0;
    let feePercent = 0;
    let usedBareme = null;
    let feeBreakdown = null;

    if (bareme) {
      const resFee = computeFeeFromBareme(bareme, amountNum, fromCur);
      fees = resFee.fee;
      feePercent = resFee.feePercent;
      feeBreakdown = resFee.breakdown;
      usedBareme = bareme;

      await Fee.updateOne({ _id: bareme._id }, { $set: { lastUsedAt: new Date() } });
    } else {
      // fallback
      let pct = 0.01;
      if (normalizedProvider === "stripe" || normalizedProvider === "bank") pct = 0.015;
      fees = roundMoney(amountNum * pct, fromCur);
      feePercent = pct * 100;
      feeBreakdown = {
        fallback: true,
        pct: feePercent,
        formula: `${amountNum} * ${feePercent}%`,
      };
    }

    const netAfterFees = roundMoney(amountNum - fees, fromCur);

    // ✅ FX marché
    const fx = await getExchangeRate(fromCur, toCur);
    const baseRate = Number(fx?.rate ?? fx);

    if (fx?.retryAfterSec) {
      res.setHeader("Retry-After", String(fx.retryAfterSec));
    }

    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      return res.status(503).json({
        success: false,
        message: "Taux de change indisponible",
      });
    }

    // ✅ FX ajusté via admin rules
    const adjusted = await getAdjustedRate({
      baseRate,
      context: {
        txType: normalizedTxType,
        method: normalizedMethod,
        provider: normalizedProvider,
        country: normalizedCountry,
        fromCountry: normalizedCountry,
        toCountry: normalizedToCountry,
        fromCurrency: fromCur,
        toCurrency: toCur,
        amount: amountNum,
      },
    });

    const appliedRate = Number(adjusted?.rate ?? baseRate);
    if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
      return res.status(503).json({
        success: false,
        message: "Taux ajusté invalide",
      });
    }

    const convertedAmount = roundMoney(amountNum * appliedRate, toCur);
    const convertedNet = roundMoney(netAfterFees * appliedRate, toCur);

    const debug = buildSimulationDebug({
      ctx,
      amountNum,
      fromCur,
      toCur,
      bareme: usedBareme,
      feeBreakdown,
      fees,
      netAfterFees,
      fx,
      baseRate,
      adjusted,
      appliedRate,
      convertedAmount,
      convertedNet,
    });

    return res.json({
      success: true,
      data: {
        txType: normalizedTxType || null,
        method: normalizedMethod || null,
        provider: normalizedProvider || null,
        country: normalizedCountry || null,
        toCountry: normalizedToCountry || null,

        amount: amountNum,
        fromCurrency: fromCur,
        toCurrency: toCur,

        // FX
        fxBaseRate: baseRate,
        exchangeRate: appliedRate,
        fxRuleApplied: adjusted?.info || null,
        fxSource: fx?.source,
        fxStale: !!fx?.stale,
        fxWarning: fx?.warning,

        // Fees
        feeSource: fees,
        feePercent,
        fees,
        feeBreakdown,
        netAfterFees,

        // Converted
        convertedAmount,
        convertedNetAfterFees: convertedNet,

        // règle choisie
        baremeId: usedBareme ? usedBareme._id : null,
        baremeSnapshot: usedBareme || null,

        // debug
        debug,
      },
    });
  } catch (e) {
    logger.error?.("[Fees] simulateFee error", e);

    const msg = String(e?.message || "");
    const status =
      e?.status ||
      (msg.toLowerCase().includes("taux") || msg.toLowerCase().includes("fx") ? 503 : 500);

    if (e?.debug?.blocked?.retryAfterSec) {
      res.setHeader("Retry-After", String(e.debug.blocked.retryAfterSec));
    }

    return res.status(status).json({
      success: false,
      message: e.message,
    });
  }
};