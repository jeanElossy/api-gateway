// middlewares/validateTransaction.js

const Joi = require('joi');
const logger = require('../src/logger');

// Schéma de base utilisé dans tous les providers
const baseSchema = {
  provider: Joi.string().valid(
    'paynoval',
    'stripe',
    'bank',
    'mobilemoney',
    'visa_direct',
    'stripe2momo',
    'cashin',
    'cashout'
  ).required(),
  amount: Joi.number().min(1).max(1000000).required(),
};

// Définition des schémas pour chaque provider/action
const initiateSchemas = {
  paynoval: Joi.object({
    ...baseSchema,
    toEmail: Joi.string().email().required(),
    message: Joi.string().max(256).optional(),
    question: Joi.string().max(128).optional(),
    funds: Joi.string().max(64).optional(),
    country: Joi.string().max(64).optional(),
    destination: Joi.string().max(128).optional(),
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
  // ---- NOUVEAUX PROVIDERS ----
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
  cashin: Joi.object({
    ...baseSchema,
    source: Joi.string().max(64).required(),
    method: Joi.string().valid('momo', 'bank', 'stripe', 'visa').required(),
    ref: Joi.string().max(128).optional(),
  }),
  cashout: Joi.object({
    ...baseSchema,
    destination: Joi.string().max(128).required(),
    method: Joi.string().valid('momo', 'bank', 'stripe', 'visa').required(),
    ref: Joi.string().max(128).optional(),
  }),
};

const confirmSchema = Joi.object({
  provider: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney',
    'visa_direct', 'stripe2momo', 'cashin', 'cashout'
  ).required(),
  transactionId: Joi.string().required(),
  code: Joi.string().optional(),
});

const cancelSchema = Joi.object({
  provider: Joi.string().valid(
    'paynoval', 'stripe', 'bank', 'mobilemoney',
    'visa_direct', 'stripe2momo', 'cashin', 'cashout'
  ).required(),
  transactionId: Joi.string().required(),
});

// Middleware principal de validation
function validateTransaction(action) {
  return function (req, res, next) {
    let schema;
    if (action === 'initiate') {
      schema = initiateSchemas[req.body.provider];
    } else if (action === 'confirm') {
      schema = confirmSchema;
    } else if (action === 'cancel') {
      schema = cancelSchema;
    }
    if (!schema) {
      logger.warn('[validateTransaction] Provider ou action non supporté', {
        provider: req.body.provider,
        action,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(400).json({ error: 'Provider ou action non supporté.' });
    }
    const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
      logger.warn(`[validateTransaction][${req.body.provider}] Validation failed (${action})`, {
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
    next();
  };
}

module.exports = validateTransaction;
