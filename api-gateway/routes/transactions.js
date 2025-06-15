// routes/transactions.js

const express = require('express');
const Joi = require('joi');
const axios = require('axios');
const config = require('../src/config');
const validate = require('../src/middlewares/validate');
const amlMiddleware = require('../src/middlewares/aml'); // Middleware AML
const router = express.Router();

/* -------- SCHEMAS DÉTAILLÉS PAR PROVIDER -------- */

// Schéma de base commun
const baseSchema = {
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  amount: Joi.number().min(1).max(1000000).required(),
};

// PAYNOVAL
const paynovalSchema = Joi.object({
  ...baseSchema,
  toEmail: Joi.string().email().required(),
  message: Joi.string().max(256).optional(),
  question: Joi.string().max(128).optional(),
});

// STRIPE
const stripeSchema = Joi.object({
  ...baseSchema,
  cardNumber: Joi.string().creditCard().required(),
  expMonth: Joi.number().min(1).max(12).required(),
  expYear: Joi.number().min(new Date().getFullYear()).max(new Date().getFullYear() + 20).required(),
  cvc: Joi.string().pattern(/^\d{3,4}$/).required(),
  cardHolder: Joi.string().max(64).required(),
  currency: Joi.string().default('EUR'),
  description: Joi.string().max(255).optional(),
});

// MOBILE MONEY
const mobilemoneySchema = Joi.object({
  ...baseSchema,
  phoneNumber: Joi.string().pattern(/^[0-9+]{8,16}$/).required(),
  operator: Joi.string().valid('orange', 'mtn', 'moov', 'wave', 'flooz').required(),
  recipientName: Joi.string().max(64).optional(),
  country: Joi.string().max(32).required(),
});

// BANK
const bankSchema = Joi.object({
  ...baseSchema,
  iban: Joi.string().pattern(/^[A-Z0-9]{15,34}$/).required(),
  bankName: Joi.string().max(128).required(),
  accountHolder: Joi.string().max(128).required(),
  country: Joi.string().max(32).required(),
  swift: Joi.string().pattern(/^[A-Z0-9]{8,11}$/).optional(),
});

/* -------- VALIDATE MIDDLEWARE DYNAMIQUE -------- */
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

// Schéma confirm (adaptable)
const confirmTxSchema = Joi.object({
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  transactionId: Joi.string().required(),
  code: Joi.string().optional(), // OTP, etc.
});

// Schéma cancel
const cancelTxSchema = Joi.object({
  provider: Joi.string().valid('paynoval', 'stripe', 'bank', 'mobilemoney').required(),
  transactionId: Joi.string().required(),
});

/* -------------------- ROUTES -------------------- */

// ---- INITIATE (avec AML intégré) ----
router.post(
  '/initiate',
  validateInitiate,     // 1. Validation syntaxique des données
  amlMiddleware,        // 2. Contrôle AML (fraude, patterns suspects)
  async (req, res) => { // 3. Forward si OK
    try {
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

      const response = await axios.post(targetUrl, req.body, {
        headers: {
          'Authorization': req.headers.authorization,
          'x-internal-token': config.internalToken,
        },
        timeout: 15000,
      });

      res.status(response.status).json(response.data);

    } catch (err) {
      if (err.response) {
        console.error('[Gateway→initiate]', err.response.status, err.response.data);
        res.status(err.response.status).json({
          error: err.response.data?.error || 'Erreur interne provider'
        });
      } else {
        console.error('[Gateway→initiate] Axios error:', err.message);
        res.status(502).json({ error: 'Service transactions indisponible.' });
      }
    }
  }
);

// ---- CONFIRM ----
router.post('/confirm', validate(confirmTxSchema), async (req, res) => {
  try {
    const { provider } = req.body;
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

    const response = await axios.post(targetUrl, req.body, {
      headers: {
        'Authorization': req.headers.authorization,
        'x-internal-token': config.internalToken,
      },
      timeout: 15000,
    });

    res.status(response.status).json(response.data);

  } catch (err) {
    if (err.response) {
      console.error('[Gateway→confirm]', err.response.status, err.response.data);
      res.status(err.response.status).json({
        error: err.response.data?.error || 'Erreur interne provider'
      });
    } else {
      console.error('[Gateway→confirm] Axios error:', err.message);
      res.status(502).json({ error: 'Service transactions indisponible.' });
    }
  }
});

// ---- CANCEL ----
router.post('/cancel', validate(cancelTxSchema), async (req, res) => {
  try {
    const { provider } = req.body;
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

    const response = await axios.post(targetUrl, req.body, {
      headers: {
        'Authorization': req.headers.authorization,
        'x-internal-token': config.internalToken,
      },
      timeout: 15000,
    });

    res.status(response.status).json(response.data);

  } catch (err) {
    if (err.response) {
      console.error('[Gateway→cancel]', err.response.status, err.response.data);
      res.status(err.response.status).json({
        error: err.response.data?.error || 'Erreur interne provider'
      });
    } else {
      console.error('[Gateway→cancel] Axios error:', err.message);
      res.status(502).json({ error: 'Service transactions indisponible.' });
    }
  }
});

module.exports = router;
