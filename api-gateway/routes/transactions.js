const express = require('express');
const Joi = require('joi');
const axios = require('axios');
const config = require('../src/config');
const validate = require('../src/middlewares/validate');
const amlMiddleware = require('../src/middlewares/aml');
const Transaction = require('../models/Transaction');
const AMLLog = require('../models/AMLLog');
const router = express.Router();

function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + clone.cardNumber.slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

// ---------------------- SCHEMAS VALIDATION ------------------------

const baseSchema = {
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  amount: Joi.number().min(1).max(1000000).required(),
};

const paynovalSchema = Joi.object({
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
});

const stripeSchema = Joi.object({
  ...baseSchema,
  currency: Joi.string().length(3).uppercase().required(),
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  toEmail: Joi.string().email().required(),
});

const mobilemoneySchema = Joi.object({
  ...baseSchema,
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave', 'flooz').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});

const bankSchema = Joi.object({
  ...baseSchema,
  iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
  bankName: Joi.string().max(128).required(),
  accountHolder: Joi.string().max(128).required(),
  country: Joi.string().max(32).required(),
  swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
});

function validateInitiate(req, res, next) {
  let schema;
  switch (req.body.provider) {
    case 'paynoval': schema = paynovalSchema; break;
    case 'stripe': schema = stripeSchema; break;
    case 'mobilemoney': schema = mobilemoneySchema; break;
    case 'bank': schema = bankSchema; break;
    default:
      return res.status(400).json({ error: 'Provider non supporté.' });
  }
  const { error } = schema.validate(req.body, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) {
    return res.status(400).json({
      success: false,
      error: 'Données invalides',
      details: error.details.map(d => d.message)
    });
  }
  next();
}

const confirmTxSchema = Joi.object({
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  transactionId: Joi.string().required(),
  code: Joi.string().optional(),
});
const cancelTxSchema = Joi.object({
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  transactionId: Joi.string().required(),
});

// ---------------------- INITIATE ----------------------
router.post(
  '/initiate',
  validateInitiate,
  amlMiddleware,
  async (req, res) => {
    const { provider } = req.body;
    let targetUrl;
    if (provider === 'paynoval') {
      targetUrl = `${config.microservices.paynoval}/transactions/initiate`;
    } else if (provider === 'stripe') {
      targetUrl = `${config.microservices.stripe}/transactions/initiate`;
    } else if (provider === 'bank') {
      targetUrl = `${config.microservices.bank}/transactions/initiate`;
    } else if (provider === 'mobilemoney') {
      targetUrl = `${config.microservices.mobilemoney}/transactions/initiate`;
    } else {
      return res.status(400).json({ error: 'Provider inconnu.' });
    }

    const userId = req.user?._id || null;
    const now = new Date();
    const amlFlag = req.amlFlag || false;
    const amlReason = req.amlReason || '';

    let reference = null;
    let statusResult = 'pending';

    try {
      const response = await axios.post(targetUrl, req.body, {
        headers: {
          'Authorization': req.headers.authorization,
          'x-internal-token': config.internalToken,
        },
        timeout: 15000,
      });

      const result = response.data;
      reference = result.reference || result.id || null;
      statusResult = result.status || 'pending';

      await AMLLog.create({
        userId,
        type: 'initiate',
        provider: req.body.provider,
        amount: req.body.amount,
        toEmail: req.body.toEmail || '',
        details: cleanSensitiveMeta(req.body),
        flagged: amlFlag,
        flagReason: amlReason,
        createdAt: now
      });

      // Stockage transaction
      await Transaction.create({
        userId,
        provider: req.body.provider,
        amount: req.body.amount,
        status: statusResult,
        toEmail: req.body.toEmail || undefined,
        toIBAN: req.body.iban || undefined,
        toPhone: req.body.phoneNumber || undefined,
        currency: req.body.currency || undefined,
        operator: req.body.operator || undefined,
        country: req.body.country || undefined,
        reference,
        meta: cleanSensitiveMeta(req.body),
        createdAt: now,
        updatedAt: now
      });

      return res.status(response.status).json(result);

    } catch (err) {
      const error = err.response?.data?.error || 'Erreur interne provider';
      const status = err.response?.status || 502;
      await AMLLog.create({
        userId,
        type: 'initiate',
        provider: req.body.provider,
        amount: req.body.amount,
        toEmail: req.body.toEmail || '',
        details: cleanSensitiveMeta({ ...req.body, error }),
        flagged: amlFlag,
        flagReason: amlReason,
        createdAt: now
      });

      await Transaction.create({
        userId,
        provider: req.body.provider,
        amount: req.body.amount,
        status: 'failed',
        toEmail: req.body.toEmail || undefined,
        toIBAN: req.body.iban || undefined,
        toPhone: req.body.phoneNumber || undefined,
        currency: req.body.currency || undefined,
        operator: req.body.operator || undefined,
        country: req.body.country || undefined,
        reference: null,
        meta: cleanSensitiveMeta({ ...req.body, error }),
        createdAt: now,
        updatedAt: now
      });

      return res.status(status).json({ error });
    }
  }
);

// ---------------------- CONFIRM ----------------------
router.post(
  '/confirm',
  validate(confirmTxSchema),
  async (req, res) => {
    const { provider, transactionId } = req.body;
    let targetUrl;
    if (provider === 'paynoval') {
      targetUrl = `${config.microservices.paynoval}/transactions/confirm`;
    } else if (provider === 'stripe') {
      targetUrl = `${config.microservices.stripe}/transactions/confirm`;
    } else if (provider === 'bank') {
      targetUrl = `${config.microservices.bank}/transactions/confirm`;
    } else if (provider === 'mobilemoney') {
      targetUrl = `${config.microservices.mobilemoney}/transactions/confirm`;
    } else {
      return res.status(400).json({ error: 'Provider inconnu.' });
    }
    const userId = req.user?._id || null;
    const now = new Date();

    try {
      const response = await axios.post(targetUrl, req.body, {
        headers: {
          'Authorization': req.headers.authorization,
          'x-internal-token': config.internalToken,
        },
        timeout: 15000,
      });
      const result = response.data;
      const newStatus = result.status || 'confirmed';

      await AMLLog.create({
        userId,
        type: 'confirm',
        provider: req.body.provider,
        amount: result.amount || 0,
        toEmail: result.toEmail || '',
        details: cleanSensitiveMeta(req.body),
        flagged: false,
        flagReason: '',
        createdAt: now
      });

      await Transaction.findOneAndUpdate(
        {
          $or: [
            { reference: transactionId },
            { 'meta.reference': transactionId },
            { 'meta.id': transactionId },
          ]
        },
        {
          $set: { status: newStatus, updatedAt: now }
        }
      );

      return res.status(response.status).json(result);

    } catch (err) {
      const error = err.response?.data?.error || 'Erreur interne provider';
      const status = err.response?.status || 502;

      await AMLLog.create({
        userId,
        type: 'confirm',
        provider: req.body.provider,
        amount: 0,
        toEmail: '',
        details: cleanSensitiveMeta({ ...req.body, error }),
        flagged: false,
        flagReason: '',
        createdAt: now
      });

      await Transaction.findOneAndUpdate(
        {
          $or: [
            { reference: transactionId },
            { 'meta.reference': transactionId },
            { 'meta.id': transactionId },
          ]
        },
        {
          $set: { status: 'failed', updatedAt: now }
        }
      );

      return res.status(status).json({ error });
    }
  }
);

// ---------------------- CANCEL ----------------------
router.post(
  '/cancel',
  validate(cancelTxSchema),
  async (req, res) => {
    const { provider, transactionId } = req.body;
    let targetUrl;
    if (provider === 'paynoval') {
      targetUrl = `${config.microservices.paynoval}/transactions/cancel`;
    } else if (provider === 'stripe') {
      targetUrl = `${config.microservices.stripe}/transactions/cancel`;
    } else if (provider === 'bank') {
      targetUrl = `${config.microservices.bank}/transactions/cancel`;
    } else if (provider === 'mobilemoney') {
      targetUrl = `${config.microservices.mobilemoney}/transactions/cancel`;
    } else {
      return res.status(400).json({ error: 'Provider inconnu.' });
    }
    const userId = req.user?._id || null;
    const now = new Date();

    try {
      const response = await axios.post(targetUrl, req.body, {
        headers: {
          'Authorization': req.headers.authorization,
          'x-internal-token': config.internalToken,
        },
        timeout: 15000,
      });
      const result = response.data;
      const newStatus = result.status || 'canceled';

      await AMLLog.create({
        userId,
        type: 'cancel',
        provider: req.body.provider,
        amount: result.amount || 0,
        toEmail: result.toEmail || '',
        details: cleanSensitiveMeta(req.body),
        flagged: false,
        flagReason: '',
        createdAt: now
      });

      await Transaction.findOneAndUpdate(
        {
          $or: [
            { reference: transactionId },
            { 'meta.reference': transactionId },
            { 'meta.id': transactionId },
          ]
        },
        {
          $set: { status: newStatus, updatedAt: now }
        }
      );

      return res.status(response.status).json(result);

    } catch (err) {
      const error = err.response?.data?.error || 'Erreur interne provider';
      const status = err.response?.status || 502;

      await AMLLog.create({
        userId,
        type: 'cancel',
        provider: req.body.provider,
        amount: 0,
        toEmail: '',
        details: cleanSensitiveMeta({ ...req.body, error }),
        flagged: false,
        flagReason: '',
        createdAt: now
      });

      await Transaction.findOneAndUpdate(
        {
          $or: [
            { reference: transactionId },
            { 'meta.reference': transactionId },
            { 'meta.id': transactionId },
          ]
        },
        {
          $set: { status: 'failed', updatedAt: now }
        }
      );

      return res.status(status).json({ error });
    }
  }
);

module.exports = router;
