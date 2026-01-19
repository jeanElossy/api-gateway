'use strict';

const Fee = require('../src/models/Fee'); // adapte le chemin si besoin
const { getExchangeRate } = require('../src/services/exchangeRateService');
const { normalizeCurrency } = require('../src/utils/currency');

let logger = null;
try {
  logger = require('../src/logger');
} catch (e) {
  logger = console;
}

// Petit helper pour calculer des frais à partir d’un barème Fee
function computeFeeFromBareme(feeDoc, amountNum) {
  if (!feeDoc) return { fee: 0, feePercent: 0 };

  let feeValue = 0;
  let feePercent = 0;

  if (feeDoc.type === 'fixed') {
    feeValue = feeDoc.amount;
    feePercent = 0;
  } else if (feeDoc.type === 'percent') {
    feePercent = feeDoc.amount; // ex: 1.5 => 1.5%
    let rawFee = (amountNum * feeDoc.amount) / 100;

    if (typeof feeDoc.minFee === 'number') rawFee = Math.max(rawFee, feeDoc.minFee);
    if (typeof feeDoc.maxFee === 'number') rawFee = Math.min(rawFee, feeDoc.maxFee);

    feeValue = parseFloat(rawFee.toFixed(2));
  }

  return { fee: feeValue, feePercent };
}

// ========== GET (CRUD) ==========
exports.getFees = async (req, res) => {
  try {
    const query = {};
    ['provider', 'country', 'currency', 'type', 'active'].forEach((field) => {
      if (req.query[field] !== undefined && req.query[field] !== '') {
        query[field] = req.query[field];
      }
    });

    if (req.query.minAmount) query.amount = { $gte: Number(req.query.minAmount) };
    if (req.query.maxAmount) {
      query.amount = { ...(query.amount || {}), $lte: Number(req.query.maxAmount) };
    }

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [fees, total] = await Promise.all([
      Fee.find(query).skip(skip).limit(limit),
      Fee.countDocuments(query),
    ]);

    res.json({ success: true, data: fees, total });
  } catch (e) {
    logger.error?.('[Fees] getFees error', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== GET BY ID ==========
exports.getFeeById = async (req, res) => {
  try {
    const fee = await Fee.findById(req.params.id);
    if (!fee) return res.status(404).json({ success: false, message: 'Fee introuvable' });
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.('[Fees] getFeeById error', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== CREATE ==========
exports.createFee = async (req, res) => {
  try {
    const fee = new Fee(req.body);
    await fee.save();
    res.status(201).json({ success: true, data: fee });
  } catch (e) {
    logger.error?.('[Fees] createFee error', e);
    res.status(400).json({ success: false, message: e.message });
  }
};

// ========== UPDATE ==========
exports.updateFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!fee) return res.status(404).json({ success: false, message: 'Fee introuvable' });
    res.json({ success: true, data: fee });
  } catch (e) {
    logger.error?.('[Fees] updateFee error', e);
    res.status(400).json({ success: false, message: e.message });
  }
};

// ========== DELETE ==========
exports.deleteFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndDelete(req.params.id);
    if (!fee) return res.status(404).json({ success: false, message: 'Fee introuvable' });
    res.json({ success: true, message: 'Fee supprimée' });
  } catch (e) {
    logger.error?.('[Fees] deleteFee error', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== SIMULATE ==========
exports.simulateFee = async (req, res) => {
  try {
    let {
      type = '', // "cancellation", "internal", etc.
      provider = '',
      amount,
      fromCurrency,
      toCurrency,
      currency, // alias pour fromCurrency
      country = '',
    } = req.query;

    // ✅ normalisation provider/country (évite mismatch DB)
    provider = String(provider || '').trim().toLowerCase();
    country = String(country || '').trim().toLowerCase();

    const fromCur = normalizeCurrency(fromCurrency || currency || '');
    const toCur = normalizeCurrency(toCurrency || fromCur || '');

    if (!amount || !fromCur) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres requis : amount, currency/fromCurrency',
      });
    }

    const amountNum = parseFloat(String(amount).replace(',', '.'));
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide' });
    }

    // 2️⃣ CAS ANNULATION
    if (type === 'cancellation') {
      let feeValue = 0;
      let feeType = 'fixed';
      let feeId = null;
      let usedBareme = null;

      const feeQuery = {
        type: 'fixed',
        active: true,
        currency: fromCur,
        minAmount: { $lte: amountNum },
        $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: { $exists: false } }],
      };

      if (provider) feeQuery.provider = provider;
      if (country) feeQuery.country = country;

      const match = await Fee.findOne(feeQuery).sort({ minAmount: -1 });

      if (match) {
        feeValue = match.amount;
        feeType = match.type;
        feeId = match._id;
        usedBareme = match;

        match.lastUsedAt = new Date();
        await match.save();
      } else {
        if (['USD', 'CAD', 'EUR'].includes(fromCur)) feeValue = 2.99;
        else if (['XOF', 'XAF'].includes(fromCur)) feeValue = 300;
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

    // 3️⃣ CAS TRANSACTION NORMALE
    const baseQuery = {
      active: true,
      currency: fromCur,
      minAmount: { $lte: amountNum },
      $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: { $exists: false } }],
    };

    if (provider) baseQuery.provider = provider;
    if (country) baseQuery.country = country;

    const bareme = await Fee.findOne(baseQuery).sort({ minAmount: -1 });

    let fees = 0;
    let feePercent = 0;
    let usedBareme = null;

    if (bareme) {
      const resFee = computeFeeFromBareme(bareme, amountNum);
      fees = resFee.fee;
      feePercent = resFee.feePercent;
      usedBareme = bareme;

      bareme.lastUsedAt = new Date();
      await bareme.save();
    } else {
      let pct = 0.01; // 1% par défaut
      if (provider === 'stripe' || provider === 'bank') pct = 0.015;
      fees = parseFloat((amountNum * pct).toFixed(2));
      feePercent = pct * 100;
    }

    const netAfterFees = amountNum - fees;

    // ✅ getExchangeRate retourne un objet { rate, source, stale, retryAfterSec... }
    const fx = await getExchangeRate(fromCur, toCur);
    const rate = Number(fx?.rate ?? fx);

    if (fx?.retryAfterSec) {
      res.setHeader('Retry-After', String(fx.retryAfterSec));
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(503).json({ success: false, message: 'Taux de change indisponible' });
    }

    const convertedAmount = parseFloat((amountNum * rate).toFixed(2));
    const convertedNet = parseFloat((netAfterFees * rate).toFixed(2));

    return res.json({
      success: true,
      data: {
        amount: amountNum,
        fromCurrency: fromCur,
        toCurrency: toCur,

        // ✅ stable
        exchangeRate: rate,
        fxSource: fx?.source,
        fxStale: !!fx?.stale,
        fxWarning: fx?.warning,

        feePercent,
        fees,
        netAfterFees: parseFloat(netAfterFees.toFixed(2)),
        convertedAmount,
        convertedNetAfterFees: convertedNet,
        baremeId: usedBareme ? usedBareme._id : null,
        baremeSnapshot: usedBareme || null,
      },
    });
  } catch (e) {
    logger.error?.('[Fees] simulateFee error', e);

    // ✅ si c’est FX -> 503, sinon garder 500
    const msg = String(e?.message || '');
    const status =
      e?.status ||
      (msg.toLowerCase().includes('taux') || msg.toLowerCase().includes('fx') ? 503 : 500);

    if (e?.debug?.blocked?.retryAfterSec) {
      res.setHeader('Retry-After', String(e.debug.blocked.retryAfterSec));
    }

    return res.status(status).json({ success: false, message: e.message });
  }
};
