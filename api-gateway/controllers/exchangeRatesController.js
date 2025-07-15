// src/controllers/exchangeRatesController.js
const ExchangeRate = require('../models/ExchangeRate');


/**
 * GET /api/v1/exchange-rates
 * Liste paginée, recherche par from/to, admin only
 */
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = req.query.from.toUpperCase();
    if (req.query.to)   query.to   = req.query.to.toUpperCase();
    if (req.query.active !== undefined) query.active = req.query.active === 'true';

    const rates = await ExchangeRate.find(query).sort({ updatedAt: -1 }).limit(100);
    res.json({ success: true, data: rates });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * POST /api/v1/exchange-rates
 * Crée un taux custom (admin only)
 */
exports.create = async (req, res) => {
  try {
    const { from, to, rate } = req.body;
    if (!from || !to || !rate) return res.status(400).json({ success: false, message: "Champs from, to, rate requis" });

    // Un seul actif par pair, désactive les anciens
    await ExchangeRate.updateMany({ from: from.toUpperCase(), to: to.toUpperCase(), active: true }, { active: false });
    const newRate = new ExchangeRate({
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      rate,
      updatedBy: req.user?.email || null // Mettre l’email de l’admin connecté
    });
    await newRate.save();
    res.status(201).json({ success: true, data: newRate });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * PUT /api/v1/exchange-rates/:id
 * Modifie un taux custom (admin only)
 */
exports.update = async (req, res) => {
  try {
    const { rate, active } = req.body;
    const update = {};
    if (rate) update.rate = rate;
    if (active !== undefined) update.active = !!active;
    update.updatedAt = new Date();
    update.updatedBy = req.user?.email || null;

    const doc = await ExchangeRate.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ success: false, message: "Taux introuvable" });
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * DELETE /api/v1/exchange-rates/:id
 * Supprime un taux custom (admin only)
 */
exports.remove = async (req, res) => {
  try {
    const doc = await ExchangeRate.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "Taux introuvable" });
    res.json({ success: true, message: "Taux supprimé" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};


/**
 * Endpoint public : obtenir le taux de change dynamique entre 2 devises
 * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
 */
exports.getRatePublic = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to)
      return res.status(400).json({ success: false, message: "from et to obligatoires" });

    const rate = await ExchangeRate.findOne({
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      active: true
    });
    if (!rate)
      return res.status(404).json({ success: false, message: "Taux de change indisponible" });

    res.json({
      success: true,
      data: {
        from: rate.from,
        to: rate.to,
        rate: rate.rate,
        updatedAt: rate.updatedAt
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
