// middlewares/validatePayment.js

const Joi = require('joi');
const logger = require('../src/logger');

// Schémas par provider
const paynovalPaymentSchema = Joi.object({
  provider: Joi.string().valid('paynoval').required(),
  toEmail: Joi.string().email().required(),
  amount: Joi.number().min(1).required(),
  question: Joi.string().max(128).allow('').optional(),
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
});

const stripePaymentSchema = Joi.object({
  provider: Joi.string().valid('stripe').required(),
  amount: Joi.number().min(1).required(),
  currency: Joi.string().length(3).uppercase().required(),
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  toEmail: Joi.string().email().required(),
});

const mobileMoneyPaymentSchema = Joi.object({
  provider: Joi.string().valid('mobilemoney').required(),
  amount: Joi.number().min(1).required(),
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});

const bankPaymentSchema = Joi.object({
  provider: Joi.string().valid('bank').required(),
  amount: Joi.number().min(1).required(),
  iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
  bankName: Joi.string().max(128).required(),
  accountHolder: Joi.string().max(128).required(),
  country: Joi.string().max(32).required(),
  swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
});

// Visa Direct
const visaDirectSchema = Joi.object({
  provider: Joi.string().valid('visa_direct').required(),
  amount: Joi.number().min(1).required(),
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  toEmail: Joi.string().email().optional(),
  country: Joi.string().max(32).optional(),
});

// Orchestration exemple Stripe → MoMo
const stripe2momoSchema = Joi.object({
  provider: Joi.string().valid('stripe2momo').required(),
  amount: Joi.number().min(1).required(),
  // Stripe side
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  // MoMo side
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave').required(),
  country: Joi.string().max(32).required(),
});

const SCHEMAS = {
  paynoval: paynovalPaymentSchema,
  stripe: stripePaymentSchema,
  bank: bankPaymentSchema,
  mobilemoney: mobileMoneyPaymentSchema,
  visa_direct: visaDirectSchema,
  stripe2momo: stripe2momoSchema,
};

function validatePayment(req, res, next) {
  const schema = SCHEMAS[req.body.provider];
  if (!schema) {
    logger.warn('[validatePayment] Provider non supporté', {
      provider: req.body.provider,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    return res.status(400).json({ error: 'Provider non supporté.' });
  }
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    logger.warn(`[validatePayment][${req.body.provider}] Validation failed`, {
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
}

module.exports = validatePayment;
