// File: src/controllers/exchangeRatesController.js
'use strict';

const ExchangeRate = require('../src/models/ExchangeRate'); // ✅ corrigé
const { getExchangeRate } = require('../src/services/exchangeRateService'); // ✅ corrigé
const logger = require('../src/logger'); // ✅ corrigé (si ton logger est bien src/logger.js)

/**
 * GET /api/v1/exchange-rates
 * Liste (admin only)
 */
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = String(req.query.from).toUpperCase();
    if (req.query.to) query.to = String(req.query.to).toUpperCase();
    if (req.query.active !== undefined) query.active = req.query.active === 'true';

    const rates = await ExchangeRate.find(query).sort({ updatedAt: -1 }).limit(100).lean();
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
    if (!from || !to || rate === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Champs from, to, rate requis',
      });
    }

    const fromCur = String(from).toUpperCase();
    const toCur = String(to).toUpperCase();
    const nRate = Number(rate);

    if (!Number.isFinite(nRate) || nRate <= 0) {
      return res.status(400).json({ success: false, message: 'rate invalide' });
    }

    // Un seul actif par pair, désactive les anciens
    await ExchangeRate.updateMany({ from: fromCur, to: toCur, active: true }, { active: false });

    const newRate = new ExchangeRate({
      from: fromCur,
      to: toCur,
      rate: nRate,
      updatedBy: req.user?.email || null,
      active: true,
    });

    await newRate.save();

    logger.info('[FX] custom rate created', { from: fromCur, to: toCur, rate: nRate, id: newRate._id });
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

    if (rate !== undefined) {
      const nRate = Number(rate);
      if (!Number.isFinite(nRate) || nRate <= 0) {
        return res.status(400).json({ success: false, message: 'rate invalide' });
      }
      update.rate = nRate;
    }

    if (active !== undefined) update.active = !!active;

    update.updatedAt = new Date();
    update.updatedBy = req.user?.email || null;

    const doc = await ExchangeRate.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Taux introuvable' });
    }

    logger.info('[FX] custom rate updated', { id: doc._id, rate: doc.rate, active: doc.active });
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
      return res.status(404).json({ success: false, message: 'Taux introuvable' });
    }

    logger.info('[FX] custom rate removed', { id: doc._id, from: doc.from, to: doc.to });
    return res.json({ success: true, message: 'Taux supprimé' });
  } catch (e) {
    logger.error('[FX] remove error', { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * Public: GET /api/v1/exchange-rates/rate?from=XOF&to=EUR
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

    const out = await getExchangeRate(from, to); // ✅ retourne {rate, source, stale...}

    const rate = Number(out?.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      logger.warn('[FX] getExchangeRate returned invalid rate', { from, to, rate });
      return res.status(503).json({
        success: false,
        message: 'Taux de change indisponible',
      });
    }

    // Retry-After si cooldown côté service (rare car service throw)
    if (out?.cooldown?.retryAfterSec) {
      res.setHeader('Retry-After', String(out.cooldown.retryAfterSec));
    }

    logger.info('[FX] /exchange-rates/rate success', { from, to, rate, source: out.source, stale: !!out.stale });

    const fromUp = String(from).toUpperCase();
    const toUp = String(to).toUpperCase();

    return res.json({
      success: true,
      rate, // 🔥 root (mobile)
      data: {
        from: fromUp,
        to: toUp,
        rate,
        source: out.source || 'fx',
        stale: !!out.stale,
        provider: out.provider,
        asOfDate: out.asOfDate,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    logger.error('[FX] /exchange-rates/rate error', {
      from,
      to,
      error: e?.message,
      debug: e?.debug,
    });

    if (e?.cooldown?.retryAfterSec) {
      res.setHeader('Retry-After', String(e.cooldown.retryAfterSec));
    }

    const status = e?.status || (e?.message === 'Taux de change indisponible' ? 503 : 500);

    return res.status(status).json({
      success: false,
      message: e?.message || 'Taux de change indisponible',
      debug: process.env.NODE_ENV === 'production' ? undefined : e?.debug,
    });
  }
};
