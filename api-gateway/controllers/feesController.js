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

// ✅ frais + ajustements admin (extraPercent/extraFixed)
function computeFeeFromBareme(feeDoc, amountNum) {
  if (!feeDoc) return { fee: 0, feePercent: 0, breakdown: null };

  const extraPercent = Number(feeDoc.extraPercent || 0);
  const extraFixed = Number(feeDoc.extraFixed || 0);

  let feeValue = 0;
  let feePercent = 0;

  if (feeDoc.type === "fixed") {
    // fixed: amount + extraFixed (extraPercent ignoré par défaut)
    feeValue = Number(feeDoc.amount || 0) + extraFixed;
    feePercent = 0;
  } else if (feeDoc.type === "percent") {
    const basePercent = Number(feeDoc.amount || 0);
    feePercent = basePercent + extraPercent;

    let rawFee = (amountNum * basePercent) / 100;
    rawFee += (amountNum * extraPercent) / 100;
    rawFee += extraFixed;

    if (typeof feeDoc.minFee === "number") rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === "number") rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = rawFee;
  }

  if (!Number.isFinite(feeValue) || feeValue < 0) feeValue = 0;

  return {
    fee: feeValue,
    feePercent,
    breakdown: {
      type: feeDoc.type,
      baseAmount: Number(feeDoc.amount || 0),
      extraPercent,
      extraFixed,
      minFee: feeDoc.minFee ?? null,
      maxFee: feeDoc.maxFee ?? null,
    },
  };
}

exports.getFees = async (req, res) => {
  try {
    const query = {};
    ["provider", "country", "currency", "type", "active"].forEach((field) => {
      if (req.query[field] !== undefined && req.query[field] !== "") {
        query[field] = req.query[field];
      }
    });

    if (req.query.minAmount) query.minAmount = { $gte: Number(req.query.minAmount) };
    if (req.query.maxAmount) {
      query.maxAmount = { ...(query.maxAmount || {}), $lte: Number(req.query.maxAmount) };
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [fees, total] = await Promise.all([
      Fee.find(query).skip(skip).limit(limit),
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
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] getFeeById error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.createFee = async (req, res) => {
  try {
    const fee = new Fee(req.body);
    await fee.save();
    res.status(201).json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] createFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.updateFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.("[Fees] updateFee error", e);
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.deleteFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndDelete(req.params.id);
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, message: "Fee supprimée" });
  } catch (e) {
    logger.error?.("[Fees] deleteFee error", e);
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.simulateFee = async (req, res) => {
  try {
    let {
      type = "", // "cancellation", ...
      provider = "",
      amount,
      fromCurrency,
      toCurrency,
      currency, // alias
      country = "",
    } = req.query;

    provider = String(provider || "").trim().toLowerCase();
    country = String(country || "").trim().toLowerCase();

    const fromCur = normalizeCurrency(fromCurrency || currency || "");
    const toCur = normalizeCurrency(toCurrency || fromCur || "");

    if (!amount || !fromCur) {
      return res.status(400).json({
        success: false,
        message: "Paramètres requis : amount, currency/fromCurrency",
      });
    }

    const amountNum = parseFloat(String(amount).replace(",", "."));
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "Montant invalide" });
    }

    // 2️⃣ ANNULATION (frais fixe)
    if (type === "cancellation") {
      let feeValue = 0;
      let feeType = "fixed";
      let feeId = null;
      let usedBareme = null;

      const feeQuery = {
        type: "fixed",
        active: true,
        currency: fromCur,
        minAmount: { $lte: amountNum },
        $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: null }, { maxAmount: { $exists: false } }],
      };

      if (provider) feeQuery.provider = provider;
      if (country) feeQuery.country = country;

      const match = await Fee.findOne(feeQuery).sort({ minAmount: -1 });

      if (match) {
        // fixed + extraFixed
        const extraFixed = Number(match.extraFixed || 0);
        feeValue = roundMoney(Number(match.amount || 0) + extraFixed, fromCur);
        feeType = match.type;
        feeId = match._id;
        usedBareme = match;

        match.lastUsedAt = new Date();
        await match.save();
      } else {
        if (["USD", "CAD", "EUR"].includes(fromCur)) feeValue = 2.99;
        else if (["XOF", "XAF"].includes(fromCur)) feeValue = 300;
        else feeValue = 2;
      }

      return res.json({
        success: true,
        data: {
          fee: feeValue,
          feeType,
          feeId,
          amount: amountNum,
          currency: fromCur,
          provider,
          country,
          snapshot: usedBareme || null,
        },
      });
    }

    // 3️⃣ TRANSACTION NORMALE (barème percent ou fixed)
    const baseQuery = {
      active: true,
      currency: fromCur,
      minAmount: { $lte: amountNum },
      $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: null }, { maxAmount: { $exists: false } }],
    };
    if (provider) baseQuery.provider = provider;
    if (country) baseQuery.country = country;

    const bareme = await Fee.findOne(baseQuery).sort({ minAmount: -1 });

    let fees = 0;
    let feePercent = 0;
    let usedBareme = null;
    let feeBreakdown = null;

    if (bareme) {
      const resFee = computeFeeFromBareme(bareme, amountNum);
      fees = resFee.fee;
      feePercent = resFee.feePercent;
      feeBreakdown = resFee.breakdown;
      usedBareme = bareme;

      bareme.lastUsedAt = new Date();
      await bareme.save();
    } else {
      // fallback: 1% (ou 1.5% pour stripe/bank)
      let pct = 0.01;
      if (provider === "stripe" || provider === "bank") pct = 0.015;
      fees = amountNum * pct;
      feePercent = pct * 100;
      feeBreakdown = { fallback: true, pct: feePercent };
    }

    // arrondi fees
    fees = roundMoney(fees, fromCur);

    const netAfterFees = roundMoney(amountNum - fees, fromCur);

    // FX market
    const fx = await getExchangeRate(fromCur, toCur);
    const baseRate = Number(fx?.rate ?? fx);

    if (fx?.retryAfterSec) res.setHeader("Retry-After", String(fx.retryAfterSec));

    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      return res.status(503).json({ success: false, message: "Taux de change indisponible" });
    }

    // ✅ FX ajusté via admin rules
    const adjusted = await getAdjustedRate({
      baseRate,
      context: {
        txType: String(type || "").toUpperCase(), // si tu préfères "TRANSFER", passe-le depuis l'app
        provider,
        country,
        fromCurrency: fromCur,
        toCurrency: toCur,
        amount: amountNum,
      },
    });

    const appliedRate = Number(adjusted.rate);
    if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
      return res.status(503).json({ success: false, message: "Taux ajusté invalide" });
    }

    const convertedAmount = roundMoney(amountNum * appliedRate, toCur);
    const convertedNet = roundMoney(netAfterFees * appliedRate, toCur);

    return res.json({
      success: true,
      data: {
        amount: amountNum,
        fromCurrency: fromCur,
        toCurrency: toCur,

        // ✅ FX
        fxBaseRate: baseRate,
        exchangeRate: appliedRate, // compat: ancien champ attendu par l'app
        fxRuleApplied: adjusted.info || null,
        fxSource: fx?.source,
        fxStale: !!fx?.stale,
        fxWarning: fx?.warning,

        // ✅ Fees
        feePercent,
        fees,
        feeBreakdown,
        netAfterFees,

        // ✅ Converted
        convertedAmount,
        convertedNetAfterFees: convertedNet,

        baremeId: usedBareme ? usedBareme._id : null,
        baremeSnapshot: usedBareme || null,
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

    return res.status(status).json({ success: false, message: e.message });
  }
};
