// // src/controllers/exchangeRatesController.js
// const ExchangeRate = require('../src/models/ExchangeRate');


// /**
//  * GET /api/v1/exchange-rates
//  * Liste paginée, recherche par from/to, admin only
//  */
// exports.list = async (req, res) => {
//   try {
//     const query = {};
//     if (req.query.from) query.from = req.query.from.toUpperCase();
//     if (req.query.to)   query.to   = req.query.to.toUpperCase();
//     if (req.query.active !== undefined) query.active = req.query.active === 'true';

//     const rates = await ExchangeRate.find(query).sort({ updatedAt: -1 }).limit(100);
//     res.json({ success: true, data: rates });
//   } catch (e) {
//     res.status(500).json({ success: false, message: e.message });
//   }
// };

// /**
//  * POST /api/v1/exchange-rates
//  * Crée un taux custom (admin only)
//  */
// exports.create = async (req, res) => {
//   try {
//     const { from, to, rate } = req.body;
//     if (!from || !to || !rate) return res.status(400).json({ success: false, message: "Champs from, to, rate requis" });

//     // Un seul actif par pair, désactive les anciens
//     await ExchangeRate.updateMany({ from: from.toUpperCase(), to: to.toUpperCase(), active: true }, { active: false });
//     const newRate = new ExchangeRate({
//       from: from.toUpperCase(),
//       to: to.toUpperCase(),
//       rate,
//       updatedBy: req.user?.email || null // Mettre l’email de l’admin connecté
//     });
//     await newRate.save();
//     res.status(201).json({ success: true, data: newRate });
//   } catch (e) {
//     res.status(400).json({ success: false, message: e.message });
//   }
// };

// /**
//  * PUT /api/v1/exchange-rates/:id
//  * Modifie un taux custom (admin only)
//  */
// exports.update = async (req, res) => {
//   try {
//     const { rate, active } = req.body;
//     const update = {};
//     if (rate) update.rate = rate;
//     if (active !== undefined) update.active = !!active;
//     update.updatedAt = new Date();
//     update.updatedBy = req.user?.email || null;

//     const doc = await ExchangeRate.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
//     if (!doc) return res.status(404).json({ success: false, message: "Taux introuvable" });
//     res.json({ success: true, data: doc });
//   } catch (e) {
//     res.status(400).json({ success: false, message: e.message });
//   }
// };

// /**
//  * DELETE /api/v1/exchange-rates/:id
//  * Supprime un taux custom (admin only)
//  */
// exports.remove = async (req, res) => {
//   try {
//     const doc = await ExchangeRate.findByIdAndDelete(req.params.id);
//     if (!doc) return res.status(404).json({ success: false, message: "Taux introuvable" });
//     res.json({ success: true, message: "Taux supprimé" });
//   } catch (e) {
//     res.status(500).json({ success: false, message: e.message });
//   }
// };


// /**
//  * Endpoint public : obtenir le taux de change dynamique entre 2 devises
//  * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
//  */
// exports.getRatePublic = async (req, res) => {
//   try {
//     const { from, to } = req.query;
//     if (!from || !to)
//       return res.status(400).json({ success: false, message: "from et to obligatoires" });

//     const rate = await ExchangeRate.findOne({
//       from: from.toUpperCase(),
//       to: to.toUpperCase(),
//       active: true
//     });
//     if (!rate)
//       return res.status(404).json({ success: false, message: "Taux de change indisponible" });

//     res.json({
//       success: true,
//       data: {
//         from: rate.from,
//         to: rate.to,
//         rate: rate.rate,
//         updatedAt: rate.updatedAt
//       }
//     });
//   } catch (e) {
//     res.status(500).json({ success: false, message: e.message });
//   }
// };





// File: src/controllers/exchangeRatesController.js
'use strict';

const ExchangeRate = require('../src/models/ExchangeRate');
const { getExchangeRate } = require('../src/services/exchangeRateService');
const logger = require('../src/logger');

/**
 * GET /api/v1/exchange-rates
 * Liste paginée, recherche par from/to, admin only
 */
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = req.query.from.toUpperCase();
    if (req.query.to) query.to = req.query.to.toUpperCase();
    if (req.query.active !== undefined)
      query.active = req.query.active === 'true';

    const rates = await ExchangeRate.find(query)
      .sort({ updatedAt: -1 })
      .limit(100);

    return res.json({ success: true, data: rates });
  } catch (e) {
    logger.error('[FX] list error', { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * POST /api/v1/exchange-rates
 * Crée un taux custom (admin only)
 */
exports.create = async (req, res) => {
  try {
    const { from, to, rate } = req.body;
    if (!from || !to || !rate) {
      return res.status(400).json({
        success: false,
        message: 'Champs from, to, rate requis',
      });
    }

    const fromCur = from.toUpperCase();
    const toCur = to.toUpperCase();

    // Un seul actif par pair, désactive les anciens
    await ExchangeRate.updateMany(
      { from: fromCur, to: toCur, active: true },
      { active: false }
    );

    const newRate = new ExchangeRate({
      from: fromCur,
      to: toCur,
      rate,
      updatedBy: req.user?.email || null, // email de l’admin connecté
    });

    await newRate.save();

    logger.info('[FX] custom rate created', {
      from: fromCur,
      to: toCur,
      rate,
      id: newRate._id,
    });

    return res.status(201).json({ success: true, data: newRate });
  } catch (e) {
    logger.error('[FX] create error', { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
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

    if (rate !== undefined) update.rate = rate;
    if (active !== undefined) update.active = !!active;

    update.updatedAt = new Date();
    update.updatedBy = req.user?.email || null;

    const doc = await ExchangeRate.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Taux introuvable' });
    }

    logger.info('[FX] custom rate updated', {
      id: doc._id,
      rate: doc.rate,
      active: doc.active,
    });

    return res.json({ success: true, data: doc });
  } catch (e) {
    logger.error('[FX] update error', { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * DELETE /api/v1/exchange-rates/:id
 * Supprime un taux custom (admin only)
 */
exports.remove = async (req, res) => {
  try {
    const doc = await ExchangeRate.findByIdAndDelete(req.params.id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Taux introuvable' });
    }

    logger.info('[FX] custom rate removed', {
      id: doc._id,
      from: doc.from,
      to: doc.to,
    });

    return res.json({ success: true, message: 'Taux supprimé' });
  } catch (e) {
    logger.error('[FX] remove error', { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Endpoint public : obtenir le taux de change dynamique entre 2 devises
 * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
 *
 * - Utilise d'abord un taux custom admin (via exchangeRateService)
 * - Sinon appelle l'API externe (via pivot) pour calculer le taux
 * - Retourne { success: true, rate, data: { from, to, rate, ... } }
 */
exports.getRatePublic = async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      success: false,
      message: 'from et to obligatoires',
    });
  }

  try {
    logger.info('[FX] /exchange-rates/rate called', { from, to });

    const rate = await getExchangeRate(from, to);

    if (typeof rate !== 'number' || rate <= 0) {
      logger.warn('[FX] getExchangeRate returned invalid rate', {
        from,
        to,
        rate,
      });
      return res.status(404).json({
        success: false,
        message: 'Taux de change indisponible',
      });
    }

    logger.info('[FX] /exchange-rates/rate success', {
      from,
      to,
      rate,
    });

    const fromUp = from.toUpperCase();
    const toUp = to.toUpperCase();

    return res.json({
      success: true,
      rate, // 🔥 directement au root pour le mobile
      data: {
        from: fromUp,
        to: toUp,
        rate,
        source: 'db_or_external',
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    logger.error('[FX] /exchange-rates/rate error', {
      from,
      to,
      error: e?.message,
    });

    // 404 si taux indisponible, 500 si autre problème
    const status =
      e?.message === 'Taux de change indisponible' ? 404 : 500;

    return res.status(status).json({
      success: false,
      message: e?.message || 'Taux de change indisponible',
    });
  }
};
