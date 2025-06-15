// routes/payment.js

const express = require('express');
const axios = require('axios');
const Joi = require('joi');
const config = require('../src/config');
const logger = require('../src/logger'); // Winston centralisé
const router = express.Router();

// -------- SCHEMAS DÉDIÉS POUR CHAQUE PROVIDER --------

// PAYNOVAL
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

// STRIPE
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

// MOBILE MONEY
const mobileMoneyPaymentSchema = Joi.object({
  provider: Joi.string().valid('mobilemoney').required(),
  amount: Joi.number().min(1).required(),
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave', 'flooz').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});

// BANK
const bankPaymentSchema = Joi.object({
  provider: Joi.string().valid('bank').required(),
  amount: Joi.number().min(1).required(),
  iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
  bankName: Joi.string().max(128).required(),
  accountHolder: Joi.string().max(128).required(),
  country: Joi.string().max(32).required(),
  swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
});

// -------- MIDDLEWARE DE VALIDATION DYNAMIQUE --------

function validatePayment(req, res, next) {
  let schema;
  switch (req.body.provider) {
    case 'paynoval': schema = paynovalPaymentSchema; break;
    case 'stripe': schema = stripePaymentSchema; break;
    case 'mobilemoney': schema = mobileMoneyPaymentSchema; break;
    case 'bank': schema = bankPaymentSchema; break;
    default:
      logger.warn('[PAYMENT] Provider non supporté', {
        provider: req.body.provider,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(400).json({ error: 'Provider non supporté.' });
  }
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    logger.warn(`[PAYMENT][${req.body.provider}] Validation failed`, {
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

// -------- ROUTE UNIQUE /api/pay --------

router.post(
  '/',
  validatePayment,
  async (req, res) => {
    const { provider } = req.body;
    let targetUrl;
    if (provider === 'paynoval') {
      targetUrl = `${config.microservices.paynoval}/pay`;
    } else if (provider === 'stripe') {
      targetUrl = `${config.microservices.stripe}/pay`;
    } else if (provider === 'mobilemoney') {
      targetUrl = `${config.microservices.mobilemoney}/pay`;
    } else if (provider === 'bank') {
      targetUrl = `${config.microservices.bank}/pay`;
    } else {
      logger.error(`[PAYMENT] Provider non supporté demandé`, {
        provider,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      });
      return res.status(400).json({ error: 'Provider non supporté.' });
    }

    try {
      const response = await axios.post(
        targetUrl,
        req.body,
        {
          headers: {
            'Authorization': req.headers.authorization,
            'x-internal-token': config.internalToken,
          },
          timeout: 15000,
        }
      );
      logger.info(`[PAYMENT→${provider}] Paiement réussi`, {
        provider,
        amount: req.body.amount,
        to: req.body.toEmail || req.body.phoneNumber || req.body.iban,
        status: response.status,
        user: req.user?.email || null,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        ref: response.data?.reference || response.data?.id || null,
      });
      res.status(response.status).json(response.data);
    } catch (err) {
      if (err.response) {
        logger.error(`[PAYMENT→${provider}] Échec API`, {
          provider,
          status: err.response.status,
          data: err.response.data,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        });
        res.status(err.response.status).json({
          error: err.response.data?.error || `Erreur interne ${provider}`
        });
      } else {
        logger.error(`[PAYMENT→${provider}] Axios error: ${err.message}`, {
          provider,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        });
        res.status(502).json({ error: `Service ${provider} temporairement indisponible.` });
      }
    }
  }
);

module.exports = router;
