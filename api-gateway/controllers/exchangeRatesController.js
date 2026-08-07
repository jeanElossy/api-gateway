"use strict";

const ExchangeRate = require("../src/models/ExchangeRate");
const {
  getExchangeRate,
  getEffectiveExchangeRate,
  getSupportedCurrencies,
} = require("../src/services/exchangeRateService");
const logger = require("../src/logger");

/* =========================================================
 * Admin CRUD custom rates
 * ========================================================= */

/**
 * GET /api/v1/exchange-rates
 * Liste admin des taux enregistrés en DB
 */
exports.list = async (req, res) => {
  try {
    const query = {};
    if (req.query.from) query.from = String(req.query.from).toUpperCase();
    if (req.query.to) query.to = String(req.query.to).toUpperCase();
    if (req.query.active !== undefined) query.active = req.query.active === "true";

    const rates = await ExchangeRate.find(query)
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();

    return res.json({ success: true, data: rates });
  } catch (e) {
    logger.error("[FX] list error", { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * POST /api/v1/exchange-rates
 * Crée un taux custom admin (active:true)
 */
exports.create = async (req, res) => {
  try {
    const { from, to, rate } = req.body;

    if (!from || !to || rate === undefined) {
      return res.status(400).json({
        success: false,
        message: "Champs from, to, rate requis",
      });
    }

    const fromCur = String(from).trim().toUpperCase();
    const toCur = String(to).trim().toUpperCase();
    const nRate = Number(rate);

    if (!Number.isFinite(nRate) || nRate <= 0) {
      return res.status(400).json({
        success: false,
        message: "rate invalide",
      });
    }

    await ExchangeRate.updateMany(
      { from: fromCur, to: toCur, active: true },
      { $set: { active: false, updatedAt: new Date() } }
    );

    const newRate = new ExchangeRate({
      from: fromCur,
      to: toCur,
      rate: nRate,
      updatedBy: req.user?.email || null,
      active: true,
      source: "db-custom",
      provider: "admin",
      asOfDate: new Date(),
      stale: false,
    });

    await newRate.save();

    logger.info("[FX] custom rate created", {
      from: fromCur,
      to: toCur,
      rate: nRate,
      id: newRate._id,
    });

    return res.status(201).json({ success: true, data: newRate });
  } catch (e) {
    logger.error("[FX] create error", { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * PUT /api/v1/exchange-rates/:id
 */
exports.update = async (req, res) => {
  try {
    const { rate, active } = req.body;
    const update = {
      updatedAt: new Date(),
      updatedBy: req.user?.email || null,
    };

    if (rate !== undefined) {
      const nRate = Number(rate);
      if (!Number.isFinite(nRate) || nRate <= 0) {
        return res.status(400).json({
          success: false,
          message: "rate invalide",
        });
      }
      update.rate = nRate;
    }

    if (active !== undefined) update.active = !!active;

    const doc = await ExchangeRate.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Taux introuvable",
      });
    }

    logger.info("[FX] custom rate updated", {
      id: doc._id,
      rate: doc.rate,
      active: doc.active,
    });

    return res.json({ success: true, data: doc });
  } catch (e) {
    logger.error("[FX] update error", { error: e.message });
    return res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * DELETE /api/v1/exchange-rates/:id
 */
exports.remove = async (req, res) => {
  try {
    const doc = await ExchangeRate.findByIdAndDelete(req.params.id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Taux introuvable",
      });
    }

    logger.info("[FX] custom rate removed", {
      id: doc._id,
      from: doc.from,
      to: doc.to,
    });

    return res.json({ success: true, message: "Taux supprimé" });
  } catch (e) {
    logger.error("[FX] remove error", { error: e.message });
    return res.status(500).json({ success: false, message: e.message });
  }
};

/* =========================================================
 * Public / admin market endpoints
 * ========================================================= */

/**
 * GET /api/v1/exchange-rates/rate?from=XOF&to=EUR&mode=live
 *
 * mode:
 * - live (default)     => vrai marché
 * - effective          => custom actif si dispo, sinon live
 */
exports.getRatePublic = async (req, res) => {
  const { from, to } = req.query;
  const mode = String(req.query.mode || "live").trim().toLowerCase();

  if (!from || !to) {
    return res.status(400).json({
      success: false,
      message: "from et to obligatoires",
    });
  }

  try {
    logger.info("[FX] /exchange-rates/rate called", {
      from,
      to,
      mode,
    });

    const fx =
      mode === "effective"
        ? await getEffectiveExchangeRate(from, to)
        : await getExchangeRate(from, to, { mode: "live" });

    const rate = Number(fx?.rate);

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(503).json({
        success: false,
        message: "Taux de change indisponible",
      });
    }

    const fromUp = String(from).toUpperCase();
    const toUp = String(to).toUpperCase();
    const inverseRate = 1 / rate;

    return res.json({
      success: true,

      // root fields
      fromCurrency: fromUp,
      toCurrency: toUp,
      marketRate: rate,
      inverseMarketRate: inverseRate,
      rate,
      inverseRate,

      source: fx?.source || (mode === "effective" ? "effective" : "live-market"),
      provider: fx?.provider || null,
      stale: !!fx?.stale,
      asOfDate: fx?.asOfDate || null,
      mode,

      data: {
        from: fromUp,
        to: toUp,
        fromCurrency: fromUp,
        toCurrency: toUp,
        rate,
        marketRate: rate,
        inverseRate,
        inverseMarketRate: inverseRate,
        source: fx?.source || (mode === "effective" ? "effective" : "live-market"),
        provider: fx?.provider || null,
        stale: !!fx?.stale,
        asOfDate: fx?.asOfDate || null,
        mode,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    logger.error("[FX] /exchange-rates/rate error", {
      from,
      to,
      mode,
      error: e?.message,
      debug: e?.debug,
    });

    if (e?.cooldown?.retryAfterSec) {
      res.setHeader("Retry-After", String(e.cooldown.retryAfterSec));
    }

    return res.status(e?.status || 500).json({
      success: false,
      message: e?.message || "Taux de change indisponible",
      debug: process.env.NODE_ENV === "production" ? undefined : e?.debug,
    });
  }
};

/**
 * GET /api/v1/exchange-rates/supported-currencies
 * Liste toutes les devises dispo côté marché réel
 */
exports.getSupportedCurrenciesPublic = async (_req, res) => {
  try {
    const out = await getSupportedCurrencies();

    return res.json({
      success: true,
      base: out.base,
      currencies: out.currencies,
      source: out.source,
      provider: out.provider,
      asOfDate: out.asOfDate,
      data: out,
    });
  } catch (e) {
    logger.error("[FX] /exchange-rates/supported-currencies error", {
      error: e?.message,
    });

    return res.status(e?.status || 500).json({
      success: false,
      message: e?.message || "Impossible de charger les devises supportées",
    });
  }
};