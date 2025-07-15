// src/controllers/feesController.js
const Fee = require('../models/Fee');
const ExchangeRate = require('../models/ExchangeRate');
const axios = require('axios');

// ========== GET (CRUD) ==========

exports.getFees = async (req, res) => {
  try {
    const query = {};
    ['provider', 'country', 'currency', 'type', 'active'].forEach(field => {
      if (req.query[field] !== undefined) query[field] = req.query[field];
    });
    if (req.query.minAmount) query.amount = { $gte: Number(req.query.minAmount) };
    if (req.query.maxAmount) query.amount = { ...(query.amount || {}), $lte: Number(req.query.maxAmount) };

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const fees = await Fee.find(query).skip(skip).limit(limit);
    const total = await Fee.countDocuments(query);

    res.json({ success: true, data: fees, total });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== GET BY ID ==========

exports.getFeeById = async (req, res) => {
  try {
    const fee = await Fee.findById(req.params.id);
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, data: fee });
  } catch (e) {
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
    res.status(400).json({ success: false, message: e.message });
  }
};

// ========== UPDATE ==========

exports.updateFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, data: fee });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

// ========== DELETE ==========

exports.deleteFee = async (req, res) => {
  try {
    const fee = await Fee.findByIdAndDelete(req.params.id);
    if (!fee) return res.status(404).json({ success: false, message: "Fee introuvable" });
    res.json({ success: true, message: "Fee supprimée" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

// ========== SIMULATE (UNIQUE, transaction & cancellation) ==========
// GET /api/v1/fees/simulate?type=...&provider=...&amount=...&fromCurrency=...&toCurrency=...&country=...

exports.simulateFee = async (req, res) => {
  try {
    const {
      type = '',        // "cancellation", "internal", etc.
      provider = '',
      amount,
      fromCurrency,
      toCurrency,
      currency,         // alias pour fromCurrency
      country = '',
    } = req.query;

    // 1️⃣ Normalize currency params
    const fromCur = (fromCurrency || currency || '').toUpperCase();
    const toCur   = (toCurrency || fromCur).toUpperCase();
    if (!amount || !fromCur) {
      return res.status(400).json({ success: false, message: "Paramètres requis : amount, currency/fromCurrency" });
    }
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "Montant invalide" });
    }

    // 2️⃣ Annulation : gestion spécifique des frais d'annulation
    if (type === "cancellation") {
      let feeValue = 0;
      let feeType = 'fixed';
      let feeId = null;

      // Recherche d’un barème personnalisé
      const match = await Fee.findOne({
        provider,
        country,
        currency: fromCur,
        type: 'fixed',
        active: true,
        minAmount: { $lte: amountNum },
        $or: [
          { maxAmount: { $gte: amountNum } },
          { maxAmount: { $exists: false } }
        ]
      }).sort({ minAmount: -1 });

      if (match) {
        feeValue = match.amount;
        feeType = match.type;
        feeId = match._id;
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
          snapshot: match || null
        }
      });
    }

    // 3️⃣ Transaction normale

    let pct = 0.01; // 1% par défaut
    const providerKey = (provider || '').toLowerCase();
    if (providerKey === 'stripe' || providerKey === 'bank') pct = 0.015;

    const fees = parseFloat((amountNum * pct).toFixed(2));
    let rate = 1;
    let convertedAmount = amountNum;
    let netAfterFees = amountNum - fees;
    let convertedNet = netAfterFees;

    // Recherche d'un taux custom admin prioritaire
    const customRate = await ExchangeRate.findOne({ from: fromCur, to: toCur, active: true });
    if (customRate) {
      rate = customRate.rate;
    } else if (fromCur !== toCur) {
      // Fallback sur l’API du marché (API publique ou privée)
      const { data } = await axios.get(
        `https://v6.exchangerate-api.com/v6/f26812ae46362d483882a0f4/latest/${fromCur}`
      );
      if (!data || !data.conversion_rates || !data.conversion_rates[toCur]) {
        return res.status(400).json({ success: false, message: "Taux de change introuvable" });
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
        feePercent: pct,
        fees,
        netAfterFees: parseFloat(netAfterFees.toFixed(2)),
        convertedAmount,
        convertedNetAfterFees: convertedNet
      }
    });

  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
