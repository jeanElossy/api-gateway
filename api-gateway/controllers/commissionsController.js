// controllers/commissionsController.js

const Commission = require('../src/models/Commission'); // Modèle mongoose
const ExchangeRate = require('../src/models/ExchangeRate');

// ✅ Logger central (src/logger.js) avec fallback console
let logger;
try {
  logger = require('../src/logger');
} catch (e) {
  logger = console;
}

/**
 * Liste toutes les commissions (avec filtres optionnels)
 * GET /api/v1/commissions
 */
exports.list = async (req, res) => {
  try {
    const filter = {};

    if (req.query.type) filter.type = req.query.type;
    if (req.query.active !== undefined) {
      filter.active = req.query.active === 'true';
    }
    if (req.query.provider) filter.provider = req.query.provider;

    const commissions = await Commission.find(filter).sort({ updatedAt: -1 });

    res.json({ success: true, data: commissions });
  } catch (err) {
    logger.error('[ADMIN][listCommissions]', err);
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
};

/**
 * Créer une commission
 * POST /api/v1/commissions
 */
exports.create = async (req, res) => {
  try {
    const commission = await Commission.create(req.body);
    logger.info(`[ADMIN][COMMISSION] créée: ${commission._id}`);
    res.json({ success: true, data: commission });
  } catch (err) {
    logger.error('[ADMIN][createCommission]', err);
    res.status(400).json({ success: false, error: err.message });
  }
};

/**
 * Modifier une commission
 * PUT /api/v1/commissions/:id
 */
exports.update = async (req, res) => {
  try {
    const commission = await Commission.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!commission) {
      return res
        .status(404)
        .json({ success: false, error: 'Commission introuvable.' });
    }

    logger.info(`[ADMIN][COMMISSION] éditée: ${req.params.id}`);
    res.json({ success: true, data: commission });
  } catch (err) {
    logger.error('[ADMIN][updateCommission]', err);
    res.status(400).json({ success: false, error: err.message });
  }
};

/**
 * Supprimer une commission
 * DELETE /api/v1/commissions/:id
 */
exports.remove = async (req, res) => {
  try {
    const commission = await Commission.findByIdAndDelete(req.params.id);

    if (!commission) {
      return res
        .status(404)
        .json({ success: false, error: 'Commission introuvable.' });
    }

    logger.warn(`[ADMIN][COMMISSION] supprimée: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('[ADMIN][removeCommission]', err);
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
};

/**
 * Simuler le calcul d’une commission
 * GET /api/v1/commissions/simulate?amount=xxx&type=xxx&fromCurrency=EUR&toCurrency=XOF&provider=paynoval
 */
exports.simulate = async (req, res) => {
  try {
    const { amount, type, provider, fromCurrency, toCurrency } = req.query;

    if (!amount || !type) {
      return res.status(400).json({
        success: false,
        error: 'Montant et type obligatoires.',
      });
    }

    const amountNum = Number(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Montant invalide.',
      });
    }

    // 1. Récupère la commission la plus pertinente
    const filter = { type, active: true };
    if (provider) filter.provider = provider;

    const commission = await Commission.findOne(filter).sort({ updatedAt: -1 });

    if (!commission) {
      return res.status(404).json({
        success: false,
        error: 'Aucune règle de commission trouvée.',
      });
    }

    let fee = Number(commission.amount);
    let resultCurrency = (commission.currency || 'XOF').toUpperCase();

    // 2. Récupère taux si conversion nécessaire
    let usedRate = 1;
    const fromCur = (fromCurrency || resultCurrency).toUpperCase();
    const toCur = (toCurrency || resultCurrency).toUpperCase();

    if (fromCur !== toCur) {
      const rateDoc = await ExchangeRate.findOne({
        from: fromCur,
        to: toCur,
        active: true,
      });

      if (rateDoc && rateDoc.rate) {
        usedRate = rateDoc.rate;
      } else {
        usedRate = 1; // fallback sécurité
      }
    }

    // 3. Applique le taux
    const computedFee = (fee * usedRate).toFixed(2);

    res.json({
      success: true,
      data: {
        commissionId: commission._id,
        baseFee: fee,
        computedFee,
        usedRate,
        provider: commission.provider || null,
        currency: resultCurrency,
        fromCurrency: fromCur,
        toCurrency: toCur,
        type,
        details: commission,
      },
    });
  } catch (err) {
    logger.error('[ADMIN][simulateCommission]', err);
    res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
};

exports.simulateCagnottePublic = exports.simulate;
