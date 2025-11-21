// controllers/transactionsController.js

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');
const Transaction = require('../src/models/Transaction');
const AMLLog = require('../src/models/AMLLog');

// Mapping centralisé avec Flutterwave ajouté
const PROVIDER_TO_SERVICE = {
  paynoval:     config.microservices.paynoval,
  stripe:       config.microservices.stripe,
  bank:         config.microservices.bank,
  mobilemoney:  config.microservices.mobilemoney,
  visa_direct:  config.microservices.visa_direct,
  visadirect:   config.microservices.visa_direct, // alias
  cashin:       config.microservices.cashin,
  cashout:      config.microservices.cashout,
  stripe2momo:  config.microservices.stripe2momo,
  flutterwave:  config.microservices.flutterwave, // NEW
};

function auditHeaders(req) {
  // Ajoute ou propage des headers d’audit pour toutes les requêtes proxy
  return {
    'Authorization': req.headers.authorization,
    'x-internal-token': config.internalToken,
    'x-request-id': req.headers['x-request-id'] || require('crypto').randomUUID(),
    'x-user-id': req.user?._id || req.headers['x-user-id'] || '',
    'x-session-id': req.headers['x-session-id'] || '',
  };
}

function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

// GET /transactions/:id → proxy vers microservice provider
exports.getTransaction = async (req, res) => {
  const { id } = req.params;
  const provider = req.query.provider || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  try {
    const response = await axios.get(`${targetService}/transactions/${id}`, {
      headers: auditHeaders(req),
      timeout: 10000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur lors du proxy GET transaction';
    logger.error('[Gateway][TX] Erreur GET transaction:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

// GET /transactions → proxy vers provider
exports.listTransactions = async (req, res) => {
  const provider = req.query.provider || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.get(`${targetService}/transactions`, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur lors du proxy GET transactions';
    logger.error('[Gateway][TX] Erreur GET transactions:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

exports.initiateTransaction = async (req, res) => {
  const targetProvider = req.routedProvider || req.body.destination || req.body.provider;
  const targetUrl = PROVIDER_TO_SERVICE[targetProvider] && PROVIDER_TO_SERVICE[targetProvider] + '/transactions/initiate';
  console.log('[DEBUG] targetUrl:', targetUrl);

  if (!targetUrl) {
    return res.status(400).json({ error: 'Provider (destination) inconnu.' });
  }

  const userId = req.user?._id || null;
  const now = new Date();
  let reference = null;
  let statusResult = 'pending';

  try {
    const response = await axios.post(targetUrl, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    const result = response.data;
    reference = result.reference || result.id || null;
    statusResult = result.status || 'pending';

    await AMLLog.create({
      userId,
      type: 'initiate',
      provider: targetProvider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId,
      provider: targetProvider,
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
      updatedAt: now,
    });

    return res.status(response.status).json(result);
  } catch (err) {
    const error = err.response?.data?.error || 'Erreur interne provider';
    const status = err.response?.status || 502;

    await AMLLog.create({
      userId,
      type: 'initiate',
      provider: targetProvider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId,
      provider: targetProvider,
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
      updatedAt: now,
    });

    return res.status(status).json({ error });
  }
};

exports.confirmTransaction = async (req, res) => {
  const provider = req.routedProvider || req.body.destination || req.body.provider;
  const { transactionId } = req.body;
  const targetUrl = PROVIDER_TO_SERVICE[provider] && PROVIDER_TO_SERVICE[provider] + '/transactions/confirm';
  if (!targetUrl) {
    return res.status(400).json({ error: 'Provider (destination) inconnu.' });
  }
  const userId = req.user?._id || null;
  const now = new Date();
  try {
    const response = await axios.post(targetUrl, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    const result = response.data;
    const newStatus = result.status || 'confirmed';

    await AMLLog.create({
      userId,
      type: 'confirm',
      provider,
      amount: result.amount || 0,
      toEmail: result.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        $or: [
          { reference: transactionId },
          { 'meta.reference': transactionId },
          { 'meta.id': transactionId },
        ],
      },
      { $set: { status: newStatus, updatedAt: now } }
    );

    return res.status(response.status).json(result);
  } catch (err) {
    const error = err.response?.data?.error || 'Erreur interne provider';
    const status = err.response?.status || 502;

    await AMLLog.create({
      userId,
      type: 'confirm',
      provider,
      amount: 0,
      toEmail: '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        $or: [
          { reference: transactionId },
          { 'meta.reference': transactionId },
          { 'meta.id': transactionId },
        ],
      },
      { $set: { status: 'failed', updatedAt: now } }
    );

    return res.status(status).json({ error });
  }
};

exports.cancelTransaction = async (req, res) => {
  const provider = req.routedProvider || req.body.destination || req.body.provider;
  const { transactionId } = req.body;
  const targetUrl = PROVIDER_TO_SERVICE[provider] && PROVIDER_TO_SERVICE[provider] + '/transactions/cancel';
  if (!targetUrl) {
    return res.status(400).json({ error: 'Provider (destination) inconnu.' });
  }
  const userId = req.user?._id || null;
  const now = new Date();
  try {
    const response = await axios.post(targetUrl, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    const result = response.data;
    const newStatus = result.status || 'canceled';

    await AMLLog.create({
      userId,
      type: 'cancel',
      provider,
      amount: result.amount || 0,
      toEmail: result.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        $or: [
          { reference: transactionId },
          { 'meta.reference': transactionId },
          { 'meta.id': transactionId },
        ],
      },
      { $set: { status: newStatus, updatedAt: now } }
    );

    return res.status(response.status).json(result);
  } catch (err) {
    const error = err.response?.data?.error || 'Erreur interne provider';
    const status = err.response?.status || 502;

    await AMLLog.create({
      userId,
      type: 'cancel',
      provider,
      amount: 0,
      toEmail: '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    await Transaction.findOneAndUpdate(
      {
        $or: [
          { reference: transactionId },
          { 'meta.reference': transactionId },
          { 'meta.id': transactionId },
        ],
      },
      { $set: { status: 'failed', updatedAt: now } }
    );

    return res.status(status).json({ error });
  }
};


// controllers/transactionsController.js (fin du fichier)

exports.refundTransaction = async (req, res) => {
  const provider = req.body.provider || req.body.destination || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];
  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.post(`${targetService}/transactions/refund`, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur proxy refund';
    logger.error('[Gateway][TX] Erreur refund:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

exports.reassignTransaction = async (req, res) => {
  const provider = req.body.provider || req.body.destination || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];
  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.post(`${targetService}/transactions/reassign`, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur proxy reassign';
    logger.error('[Gateway][TX] Erreur reassign:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};


// Proxy vers le microservice PayNoval pour /validate
exports.validateTransaction = async (req, res) => {
  const provider = req.body.provider || 'paynoval'; // ou destination, à adapter selon ton usage
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  try {
    const response = await axios.post(`${targetService}/transactions/validate`, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur proxy /validate';
    logger.error('[Gateway][TX] Erreur VALIDATE:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};


// ARCHIVER une transaction
exports.archiveTransaction = async (req, res) => {
  const provider = req.body.provider || req.body.destination || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];
  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.post(`${targetService}/transactions/archive`, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur proxy archive';
    logger.error('[Gateway][TX] Erreur archive:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

// RELANCER une transaction
exports.relaunchTransaction = async (req, res) => {
  const provider = req.body.provider || req.body.destination || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];
  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.post(`${targetService}/transactions/relaunch`, req.body, {
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur proxy relaunch';
    logger.error('[Gateway][TX] Erreur relaunch:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};


