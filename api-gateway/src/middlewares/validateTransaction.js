// File: middlewares/validateTransaction.js

const Joi = require('joi');
const logger = require('../logger');
const allowedFlows = require('../tools/allowedFlows');
const { getSingleTxLimit, getDailyLimit } = require('../tools/amlLimits');
const { getUserTransactionsStats } = require('../services/aml'); // Doit exister

const baseSchema = {
  funds: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney', 'visa_direct', 'stripe2momo'
  ).required(),
  destination: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney', 'visa_direct', 'stripe2momo'
  ).required(),
  amount: Joi.number().min(1).required(),
  provider: Joi.string().optional(),
  action: Joi.string().valid('send', 'deposit', 'withdraw').optional()
};

const initiateSchemas = {
  paynoval: Joi.object({
    ...baseSchema,
    toEmail: Joi.string().email().required(),
    message: Joi.string().max(256).optional(),
    question: Joi.string().max(128).optional(),
    recipientInfo: Joi.object().unknown(true).optional(),
    exchangeRate: Joi.number().min(0).optional(),
    transactionFees: Joi.number().min(0).optional(),
    localAmount: Joi.number().min(0).optional(),
    localCurrencySymbol: Joi.string().max(8).optional(),
    senderCurrencySymbol: Joi.string().max(8).optional(),
    selectedCurrency: Joi.string().max(8).optional(),
    securityCode: Joi.string().max(32).allow('').optional(),
  }),
  stripe: Joi.object({
    ...baseSchema,
    currency: Joi.string().length(3).uppercase().required(),
    cardNumber: Joi.string().creditCard().required(),
    expMonth: Joi.number().min(1).max(12).required(),
    expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
    cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
    cardHolder: Joi.string().max(64).required(),
    toEmail: Joi.string().email().required(),
  }),
  mobilemoney: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
    recipientName: Joi.string().max(64).optional(),
    country: Joi.string().max(32).required(),
  }),
  bank: Joi.object({
    ...baseSchema,
    iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
    bankName: Joi.string().max(128).required(),
    accountHolder: Joi.string().max(128).required(),
    country: Joi.string().max(32).required(),
    swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
  }),
  visa_direct: Joi.object({
    ...baseSchema,
    cardNumber: Joi.string().creditCard().required(),
    cardHolder: Joi.string().max(64).required(),
    expMonth: Joi.number().min(1).max(12).required(),
    expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
    cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
    toName: Joi.string().max(128).required(),
    toBank: Joi.string().max(128).optional(),
    country: Joi.string().max(32).optional(),
  }),
  stripe2momo: Joi.object({
    ...baseSchema,
    phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
    operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
    country: Joi.string().max(32).required(),
    stripeRef: Joi.string().max(128).optional(),
  }),
};

const confirmSchema = Joi.object({
  provider: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney', 'visa_direct', 'stripe2momo'
  ).required(),
  transactionId: Joi.string().required(),
  code: Joi.string().optional(),
});

const cancelSchema = Joi.object({
  provider: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney', 'visa_direct', 'stripe2momo'
  ).required(),
  transactionId: Joi.string().required(),
});

function getDestinationProvider(body) {
  return body.destination;
}

function validateTransaction(action) {
  return function (req, res, next) {
    let dest = getDestinationProvider(req.body);

    // Plafond single transaction dynamique
    let maxLimit = 10000000;
    if (action === 'initiate') {
      try {
        const provider = req.body.destination || req.body.provider || dest;
        const currency =
          req.body.selectedCurrency ||
          req.body.currencySender ||
          req.body.currency ||
          'F CFA';
        maxLimit = getSingleTxLimit(provider, currency);
      } catch (e) {}
    }

    // Préparation du schéma dynamique
    let schema;
    if (action === 'initiate' && initiateSchemas[dest]) {
      schema = initiateSchemas[dest].keys({
        amount: Joi.number().min(1).max(maxLimit).required()
      });
    } else if (action === 'confirm') {
      schema = confirmSchema;
    } else if (action === 'cancel') {
      schema = cancelSchema;
    }

    if (!schema) {
      logger.warn('[validateTransaction] Destination/action non supporté', {
        destination: dest,
        action,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(400).json({ error: 'Provider ou action non supporté.' });
    }

    const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
      logger.warn(`[validateTransaction][${dest}] Validation failed (${action})`, {
        details: error.details.map(d => d.message),
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        email: req.body.toEmail || null,
      });
      return res.status(400).json({
        success: false,
        error: 'Données invalides',
        details: error.details.map(d => d.message)
      });
    }

    // Vérification des flux autorisés (funds/destination)
    if (action === 'initiate') {
      const match = allowedFlows.find(f =>
        f.funds === req.body.funds &&
        f.destination === req.body.destination &&
        (!f.action || f.action === (req.body.action || 'send'))
      );
      if (!match) {
        logger.warn(`[validateTransaction] Flux funds/destination non autorisé`, {
          funds: req.body.funds,
          destination: req.body.destination,
          action: req.body.action,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        });
        return res.status(400).json({ error: "Ce flux funds/destination n'est pas autorisé." });
      }
      req.routedProvider = req.body.destination;

      // ----- Daily limit UX-friendly check -----
      (async () => {
        try {
          const userId = req.user && req.user._id;
          if (userId) {
            const provider = req.body.destination || req.body.provider || dest;
            const currency =
              req.body.selectedCurrency ||
              req.body.currencySender ||
              req.body.currency ||
              'F CFA';
            const dailyLimit = getDailyLimit(provider, currency);
            const stats = await getUserTransactionsStats(userId, provider, currency);
            const dailyTotal = (stats && stats.dailyTotal ? stats.dailyTotal : 0) + (req.body.amount || 0);

            if (dailyTotal > dailyLimit) {
              logger.warn('[validateTransaction] Plafond journalier dépassé', {
                userId, provider, currency, try: req.body.amount, already: stats?.dailyTotal, max: dailyLimit
              });
              return res.status(403).json({
                error: 'Dépasse le plafond journalier autorisé',
                details: {
                  max: dailyLimit,
                  currency,
                  provider,
                  already: stats?.dailyTotal,
                  try: req.body.amount
                }
              });
            }
          }
          next();
        } catch (e) {
          logger.error('[validateTransaction] Erreur vérification daily limit', { err: e });
          next();
        }
      })();
      return;
    }

    next();
  };
}

module.exports = validateTransaction;
