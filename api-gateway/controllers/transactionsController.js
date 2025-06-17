const axios = require('axios');
const config = require('../src/config');
const logger = require('../logger');
const Transaction = require('../src/models/Transaction');
const AMLLog = require('../src/models/AMLLog');

// — Ajoute ici tous tes providers : clé logique = nom provider, valeur = URL microservice
const PROVIDER_TO_SERVICE = {
  paynoval:     config.microservices.paynoval,
  stripe:       config.microservices.stripe,
  bank:         config.microservices.bank,
  mobilemoney:  config.microservices.mobilemoney,
  visadirect:   config.microservices.visadirect,
  visa_direct:  config.microservices.visa_direct,      // <- ajouté ici
  cashin:       config.microservices.cashin,
  cashout:      config.microservices.cashout,
  stripe2momo:  config.microservices.stripe2momo,      // <- ajouté ici
  // ...etc (ajoute autant que tu veux !)
};

function cleanSensitiveMeta(meta) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + clone.cardNumber.slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

exports.listTransactions = async (req, res) => {
  const provider = req.query.provider || 'paynoval';
  const targetService = PROVIDER_TO_SERVICE[provider];
  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }
  try {
    const response = await axios.get(`${targetService}/transactions`, {
      headers: {
        'Authorization': req.headers.authorization,
        'x-internal-token': config.internalToken,
      },
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error = err.response?.data?.error || 'Erreur lors du proxy GET transactions';
    logger.error('[Gateway][TX] Erreur GET transactions:', { status, error });
    return res.status(status).json({ success: false, error });
  }
};

exports.initiateTransaction = async (req, res) => {
  const { provider } = req.body;
  const targetUrl = PROVIDER_TO_SERVICE[provider] && PROVIDER_TO_SERVICE[provider] + '/transactions/initiate';
  if (!targetUrl) {
    return res.status(400).json({ error: 'Provider inconnu.' });
  }
  const userId = req.user?._id || null;
  const now = new Date();
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
      provider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta(req.body),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId,
      provider,
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
      provider,
      amount: req.body.amount,
      toEmail: req.body.toEmail || '',
      details: cleanSensitiveMeta({ ...req.body, error }),
      flagged: req.amlFlag || false,
      flagReason: req.amlReason || '',
      createdAt: now,
    });

    await Transaction.create({
      userId,
      provider,
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
  const { provider, transactionId } = req.body;
  const targetUrl = PROVIDER_TO_SERVICE[provider] && PROVIDER_TO_SERVICE[provider] + '/transactions/confirm';
  if (!targetUrl) {
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
  const { provider, transactionId } = req.body;
  const targetUrl = PROVIDER_TO_SERVICE[provider] && PROVIDER_TO_SERVICE[provider] + '/transactions/cancel';
  if (!targetUrl) {
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
