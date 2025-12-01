// controllers/feesController.js

const Fee = require('../src/models/Fee');
const ExchangeRate = require('../src/models/ExchangeRate');
const axios = require('axios');

// Optionnel : logger central
let logger = null;
try {
  logger = require('../src/logger');
} catch (e) {
  logger = console;
}

// Config FX (à mettre dans ton .env)
const FX_API_BASE_URL =
  process.env.FX_API_BASE_URL || 'https://v6.exchangerate-api.com/v6';
const FX_API_KEY = process.env.FX_API_KEY || 'REPLACE_ME';

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

    if (typeof feeDoc.minFee === 'number') {
      rawFee = Math.max(rawFee, feeDoc.minFee);
    }
    if (typeof feeDoc.maxFee === 'number') {
      rawFee = Math.min(rawFee, feeDoc.maxFee);
    }

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

    if (req.query.minAmount) {
      query.amount = { $gte: Number(req.query.minAmount) };
    }
    if (req.query.maxAmount) {
      query.amount = {
        ...(query.amount || {}),
        $lte: Number(req.query.maxAmount),
      };
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
    if (!fee) {
      return res
        .status(404)
        .json({ success: false, message: 'Fee introuvable' });
    }
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
    if (!fee) {
      return res
        .status(404)
        .json({ success: false, message: 'Fee introuvable' });
    }
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
    if (!fee) {
      return res
        .status(404)
        .json({ success: false, message: 'Fee introuvable' });
    }
    res.json({ success: true, message: 'Fee supprimée' });
  } catch (e) {
    logger.error?.('[Fees] deleteFee error', e);
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== SIMULATE (UNIQUE, transaction & cancellation) ==========
// GET /api/v1/fees/simulate?type=...&provider=...&amount=...&fromCurrency=...&toCurrency=...&country=...

exports.simulateFee = async (req, res) => {
  try {
    const {
      type = '', // "cancellation", "internal", etc.
      provider = '',
      amount,
      fromCurrency,
      toCurrency,
      currency, // alias pour fromCurrency
      country = '',
    } = req.query;

    // 1️⃣ Normalisation des devises
    const fromCur = (fromCurrency || currency || '').toUpperCase();
    const toCur = (toCurrency || fromCur).toUpperCase();

    if (!amount || !fromCur) {
      return res.status(400).json({
        success: false,
        message: 'Paramètres requis : amount, currency/fromCurrency',
      });
    }

    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Montant invalide' });
    }

    // 2️⃣ CAS ANNULATION (barème dédié type "cancellation" ou "fixed" spécifique)
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

        // met à jour lastUsedAt
        match.lastUsedAt = new Date();
        await match.save();
      } else {
        // Fallback : barème par devise
        if (['USD', 'CAD', 'EUR'].includes(fromCur)) {
          feeValue = 2.99;
        } else if (['XOF', 'XAF', 'F CFA'].includes(fromCur)) {
          feeValue = 300;
        } else {
          feeValue = 2;
        }
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

    // 3.1 – Essayer de trouver un barème dans la collection Fee
    const baseQuery = {
      active: true,
      currency: fromCur,
      minAmount: { $lte: amountNum },
      $or: [{ maxAmount: { $gte: amountNum } }, { maxAmount: { $exists: false } }],
    };

    if (provider) baseQuery.provider = provider;
    if (country) baseQuery.country = country;

    // On ne filtre pas par type ici, on accepte "fixed" ou "percent"
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
      // 3.2 – Fallback simple si aucun barème / pas encore de config
      let pct = 0.01; // 1% par défaut

      const providerKey = (provider || '').toLowerCase();
      if (providerKey === 'stripe' || providerKey === 'bank') {
        pct = 0.015;
      }

      fees = parseFloat((amountNum * pct).toFixed(2));
      feePercent = pct * 100; // ex: 0.01 -> 1
    }

    const netAfterFees = amountNum - fees;

    // 4️⃣ Taux de change

    let rate = 1;
    let convertedAmount = amountNum;
    let convertedNet = netAfterFees;

    // Taux custom admin prioritaire
    const customRate = await ExchangeRate.findOne({
      from: fromCur,
      to: toCur,
      active: true,
    });

    if (customRate) {
      rate = customRate.rate;
    } else if (fromCur !== toCur) {
      // Fallback API FX
      if (FX_API_KEY === 'REPLACE_ME') {
        return res.status(500).json({
          success: false,
          message:
            "Configuration FX manquante (FX_API_KEY). Merci de configurer l'API de taux de change.",
        });
      }

      const url = `${FX_API_BASE_URL}/${FX_API_KEY}/latest/${fromCur}`;
      const { data } = await axios.get(url);

      if (!data || !data.conversion_rates || !data.conversion_rates[toCur]) {
        return res
          .status(400)
          .json({ success: false, message: 'Taux de change introuvable' });
      }

      rate = data.conversion_rates[toCur];
    }

    convertedAmount = parseFloat((amountNum * rate).toFixed(2));
    convertedNet = parseFloat((netAfterFees * rate).toFixed(2));

    return res.json({
      success: true,
      data: {
        amount: amountNum,
        fromCurrency: fromCur,
        toCurrency: toCur,
        exchangeRate: rate,
        feePercent, // % effectif si barème percent, ou fallback (1%, 1.5%, etc.)
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
    res.status(500).json({ success: false, message: e.message });
  }
};
