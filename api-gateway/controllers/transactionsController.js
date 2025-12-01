// // controllers/transactionsController.js

// const axios = require('axios');
// const config = require('../src/config');
// const logger = require('../src/logger');
// const Transaction = require('../src/models/Transaction');
// const AMLLog = require('../src/models/AMLLog');
// const crypto = require('crypto');

// /**
//  * Mapping centralisé des providers -> service URL
//  * Ajoute ici toute nouvelle intégration (flutterwave, stripe, etc.)
//  */
// const PROVIDER_TO_SERVICE = {
//   paynoval:     config.microservices.paynoval,
//   stripe:       config.microservices.stripe,
//   bank:         config.microservices.bank,
//   mobilemoney:  config.microservices.mobilemoney,
//   visa_direct:  config.microservices.visa_direct,
//   visadirect:   config.microservices.visa_direct, // alias
//   cashin:       config.microservices.cashin,
//   cashout:      config.microservices.cashout,
//   stripe2momo:  config.microservices.stripe2momo,
//   flutterwave:  config.microservices.flutterwave, // NEW
// };

// /* Safe UUID helper (Node < 14 fallback) */
// function safeUUID() {
//   if (crypto && typeof crypto.randomUUID === 'function') {
//     try { return crypto.randomUUID(); } catch (e) { /* fallback */ }
//   }
//   return (
//     Date.now().toString(16) +
//     '-' +
//     Math.floor(Math.random() * 0xffff).toString(16) +
//     '-' +
//     Math.floor(Math.random() * 0xffff).toString(16)
//   );
// }

// /* Clean sensitive fields before logging/storing */
// function cleanSensitiveMeta(meta) {
//   const clone = { ...meta };
//   if (clone.cardNumber) clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
//   if (clone.cvc) delete clone.cvc;
//   if (clone.securityCode) delete clone.securityCode;
//   return clone;
// }

// /**
//  * Helper pour récupérer l'userId de manière sûre
//  */
// function getUserId(req) {
//   return req.user?._id || req.user?.id || null;
// }

// /**
//  * Build headers to forward to microservices
//  * - Forward Authorization only when it is present and truthy (avoid "Bearer null")
//  * - Always include internal token for inter-service authentication
//  * - Add x-request-id (generated when missing)
//  * - Include x-user-id/x-session-id when available
//  */
// function auditHeaders(req) {
//   const incomingAuth = req.headers.authorization || req.headers.Authorization || null;
//   const hasAuth = !!incomingAuth && String(incomingAuth).toLowerCase() !== 'bearer null' && String(incomingAuth).trim() !== 'null';

//   const reqId = req.headers['x-request-id'] || req.id || safeUUID();
//   const userId = getUserId(req) || req.headers['x-user-id'] || '';

//   const headers = {
//     Accept: 'application/json',
//     'x-internal-token': config.internalToken || '',
//     'x-request-id': reqId,
//     'x-user-id': userId,
//     'x-session-id': req.headers['x-session-id'] || '',
//     ...(req.headers['x-device-id'] ? { 'x-device-id': req.headers['x-device-id'] } : {}),
//   };

//   if (hasAuth) {
//     headers.Authorization = incomingAuth;
//   }

//   // DEBUG logs temporaires
//   try {
//     const authPreview = headers.Authorization ? String(headers.Authorization).slice(0, 12) : null;
//     logger.debug('[Gateway][AUDIT HEADERS] forwarding', {
//       authPreview,
//       xInternalToken: headers['x-internal-token'],
//       requestId: reqId,
//       userId,
//       dest: req.path,
//     });
//   } catch (e) { /* noop */ }

//   return headers;
// }

// /* Safe axios request wrapper that logs richer info on errors */
// async function safeAxiosRequest(opts) {
//   try {
//     return await axios(opts);
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const data = err.response?.data || null;
//     const message = err.message || 'Unknown axios error';
//     logger.error('[Gateway][Axios] request failed', { url: opts.url, method: opts.method, status, data, message });
//     const e = new Error(message);
//     e.response = err.response;
//     throw e;
//   }
// }

// /* ---------- Controller actions ---------- */

// // GET /transactions/:id
// exports.getTransaction = async (req, res) => {
//   const { id } = req.params;
//   const provider = req.query.provider || 'paynoval';
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const base = String(targetService).replace(/\/+$/, '');
//   const url = `${base}/transactions/${encodeURIComponent(id)}`;

//   try {
//     const response = await safeAxiosRequest({
//       method: 'get',
//       url,
//       headers: auditHeaders(req),
//       params: req.query,
//       timeout: 10000,
//     });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const error = err.response?.data?.error || err.response?.data?.message || 'Erreur lors du proxy GET transaction';
//     logger.error('[Gateway][TX] Erreur GET transaction:', { status, error, provider, transactionId: id });
//     return res.status(status).json({ success: false, error });
//   }
// };

// // GET /transactions
// exports.listTransactions = async (req, res) => {
//   const provider = req.query.provider || 'paynoval';
//   const targetService = PROVIDER_TO_SERVICE[provider];

//   if (!targetService) {
//     return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
//   }

//   const base = String(targetService).replace(/\/+$/, '');
//   const url = `${base}/transactions`;

//   try {
//     const response = await safeAxiosRequest({
//       method: 'get',
//       url,
//       headers: auditHeaders(req),
//       params: req.query,
//       timeout: 15000,
//     });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const error = err.response?.data?.error || err.response?.data?.message || 'Erreur lors du proxy GET transactions';
//     logger.error('[Gateway][TX] Erreur GET transactions:', { status, error, provider });
//     return res.status(status).json({ success: false, error });
//   }
// };

// // POST /transactions/initiate
// exports.initiateTransaction = async (req, res) => {
//   const targetProvider = req.routedProvider || req.body.destination || req.body.provider;
//   const targetService = PROVIDER_TO_SERVICE[targetProvider];
//   const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/initiate' : null;
//   logger.debug('[Gateway][TX] initiateTransaction targetUrl', { targetProvider, targetUrl });

//   if (!targetUrl) return res.status(400).json({ error: 'Provider (destination) inconnu.' });

//   const userId = getUserId(req);
//   const now = new Date();
//   let reference = null;
//   let statusResult = 'pending';

//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditHeaders(req),
//       timeout: 15000,
//     });
//     const result = response.data;
//     reference = result.reference || result.id || null;
//     statusResult = result.status || 'pending';

//     await AMLLog.create({
//       userId,
//       type: 'initiate',
//       provider: targetProvider,
//       amount: req.body.amount,
//       toEmail: req.body.toEmail || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: req.amlFlag || false,
//       flagReason: req.amlReason || '',
//       createdAt: now,
//     });

//     await Transaction.create({
//       userId,
//       provider: targetProvider,
//       amount: req.body.amount,
//       status: statusResult,
//       toEmail: req.body.toEmail || undefined,
//       toIBAN: req.body.iban || undefined,
//       toPhone: req.body.phoneNumber || undefined,
//       currency: req.body.currency || undefined,
//       operator: req.body.operator || undefined,
//       country: req.body.country || undefined,
//       reference,
//       meta: cleanSensitiveMeta(req.body),
//       createdAt: now,
//       updatedAt: now,
//     });

//     return res.status(response.status).json(result);
//   } catch (err) {
//     const error = err.response?.data?.error || err.response?.data?.message || err.message || 'Erreur interne provider';
//     const status = err.response?.status || 502;

//     await AMLLog.create({
//       userId,
//       type: 'initiate',
//       provider: targetProvider,
//       amount: req.body.amount,
//       toEmail: req.body.toEmail || '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: req.amlFlag || false,
//       flagReason: req.amlReason || '',
//       createdAt: now,
//     });

//     await Transaction.create({
//       userId,
//       provider: targetProvider,
//       amount: req.body.amount,
//       status: 'failed',
//       toEmail: req.body.toEmail || undefined,
//       toIBAN: req.body.iban || undefined,
//       toPhone: req.body.phoneNumber || undefined,
//       currency: req.body.currency || undefined,
//       operator: req.body.operator || undefined,
//       country: req.body.country || undefined,
//       reference: null,
//       meta: cleanSensitiveMeta({ ...req.body, error }),
//       createdAt: now,
//       updatedAt: now,
//     });

//     logger.error('[Gateway][TX] initiateTransaction failed', { provider: targetProvider, error, status });
//     return res.status(status).json({ error });
//   }
// };

// // POST /transactions/confirm
// exports.confirmTransaction = async (req, res) => {
//   const provider = req.routedProvider || req.body.destination || req.body.provider;
//   const { transactionId } = req.body;
//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/confirm' : null;

//   if (!targetUrl) return res.status(400).json({ error: 'Provider (destination) inconnu.' });

//   const userId = getUserId(req);
//   const now = new Date();

//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditHeaders(req),
//       timeout: 15000,
//     });
//     const result = response.data;
//     const newStatus = result.status || 'confirmed';

//     await AMLLog.create({
//       userId,
//       type: 'confirm',
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.toEmail || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       { $set: { status: newStatus, updatedAt: now } }
//     );

//     return res.status(response.status).json(result);
//   } catch (err) {
//     const error = err.response?.data?.error || err.response?.data?.message || err.message || 'Erreur interne provider';
//     const status = err.response?.status || 502;

//     await AMLLog.create({
//       userId,
//       type: 'confirm',
//       provider,
//       amount: 0,
//       toEmail: '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       { $set: { status: 'failed', updatedAt: now } }
//     );

//     logger.error('[Gateway][TX] confirmTransaction failed', { provider, error, status });
//     return res.status(status).json({ error });
//   }
// };

// // POST /transactions/cancel
// exports.cancelTransaction = async (req, res) => {
//   const provider = req.routedProvider || req.body.destination || req.body.provider;
//   const { transactionId } = req.body;
//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const targetUrl = targetService ? String(targetService).replace(/\/+$/, '') + '/transactions/cancel' : null;

//   if (!targetUrl) return res.status(400).json({ error: 'Provider (destination) inconnu.' });

//   const userId = getUserId(req);
//   const now = new Date();

//   try {
//     const response = await safeAxiosRequest({
//       method: 'post',
//       url: targetUrl,
//       data: req.body,
//       headers: auditHeaders(req),
//       timeout: 15000,
//     });
//     const result = response.data;
//     const newStatus = result.status || 'canceled';

//     await AMLLog.create({
//       userId,
//       type: 'cancel',
//       provider,
//       amount: result.amount || 0,
//       toEmail: result.toEmail || '',
//       details: cleanSensitiveMeta(req.body),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       { $set: { status: newStatus, updatedAt: now } }
//     );

//     return res.status(response.status).json(result);
//   } catch (err) {
//     const error = err.response?.data?.error || err.response?.data?.message || err.message || 'Erreur interne provider';
//     const status = err.response?.status || 502;

//     await AMLLog.create({
//       userId,
//       type: 'cancel',
//       provider,
//       amount: 0,
//       toEmail: '',
//       details: cleanSensitiveMeta({ ...req.body, error }),
//       flagged: false,
//       flagReason: '',
//       createdAt: now,
//     });

//     await Transaction.findOneAndUpdate(
//       {
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       { $set: { status: 'failed', updatedAt: now } }
//     );

//     logger.error('[Gateway][TX] cancelTransaction failed', { provider, error, status });
//     return res.status(status).json({ error });
//   }
// };

// /* Refund / Reassign / Validate / Archive / Relaunch share the same pattern */
// exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, 'refund');
// exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, 'reassign');
// exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, 'validate');
// exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, 'archive');
// exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, 'relaunch');

// /* Helper générique pour proxyer les actions simples */
// async function forwardTransactionProxy(req, res, action) {
//   const provider = req.body.provider || req.body.destination || 'paynoval';
//   const targetService = PROVIDER_TO_SERVICE[provider];
//   if (!targetService) return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });

//   const url = String(targetService).replace(/\/+$/, '') + `/transactions/${action}`;
//   try {
//     const response = await safeAxiosRequest({ method: 'post', url, data: req.body, headers: auditHeaders(req), timeout: 15000 });
//     return res.status(response.status).json(response.data);
//   } catch (err) {
//     const status = err.response?.status || 502;
//     const error = err.response?.data?.error || err.message || `Erreur proxy ${action}`;
//     logger.error(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
//     return res.status(status).json({ success: false, error });
//   }
// }




// controllers/transactionsController.js

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');
const Transaction = require('../src/models/Transaction');
const AMLLog = require('../src/models/AMLLog');
const crypto = require('crypto');

/**
 * Mapping centralisé des providers -> service URL
 * Ajoute ici toute nouvelle intégration (flutterwave, stripe, etc.)
 */
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

/* Safe UUID helper (Node < 14 fallback) */
function safeUUID() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch (e) { /* fallback */ }
  }
  return (
    Date.now().toString(16) +
    '-' +
    Math.floor(Math.random() * 0xffff).toString(16) +
    '-' +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

/* Clean sensitive fields before logging/storing */
function cleanSensitiveMeta(meta = {}) {
  const clone = { ...meta };
  if (clone.cardNumber) clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
  if (clone.cvc) delete clone.cvc;
  if (clone.securityCode) delete clone.securityCode;
  return clone;
}

/**
 * Helper pour récupérer l'userId de manière sûre
 */
function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

/**
 * Helper pour résoudre le provider (priorité : routedProvider > body.provider > body.destination > query.provider > fallback)
 */
function resolveProvider(req, fallback = 'paynoval') {
  const body = req.body || {};
  const query = req.query || {};

  return (
    req.routedProvider ||
    body.provider ||
    body.destination ||
    query.provider ||
    fallback
  );
}

/**
 * Build headers to forward to microservices
 * - Forward Authorization only when it is present and truthy (avoid "Bearer null")
 * - Always include internal token for inter-service authentication
 * - Add x-request-id (generated when missing)
 * - Include x-user-id/x-session-id when available
 */
function auditHeaders(req) {
  const incomingAuth = req.headers.authorization || req.headers.Authorization || null;
  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== 'bearer null' &&
    String(incomingAuth).trim().toLowerCase() !== 'null';

  const reqId = req.headers['x-request-id'] || req.id || safeUUID();
  const userId = getUserId(req) || req.headers['x-user-id'] || '';

  const headers = {
    Accept: 'application/json',
    'x-internal-token': config.internalToken || '',
    'x-request-id': reqId,
    'x-user-id': userId,
    'x-session-id': req.headers['x-session-id'] || '',
    ...(req.headers['x-device-id'] ? { 'x-device-id': req.headers['x-device-id'] } : {}),
  };

  if (hasAuth) {
    headers.Authorization = incomingAuth;
  }

  // DEBUG logs temporaires
  try {
    const authPreview = headers.Authorization ? String(headers.Authorization).slice(0, 12) : null;
    logger.debug('[Gateway][AUDIT HEADERS] forwarding', {
      authPreview,
      xInternalToken: headers['x-internal-token'],
      requestId: reqId,
      userId,
      dest: req.path,
    });
  } catch (e) {
    // noop
  }

  return headers;
}

/* Safe axios request wrapper that logs richer info on errors */
async function safeAxiosRequest(opts) {
  try {
    return await axios(opts);
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || null;
    const message = err.message || 'Unknown axios error';
    logger.error('[Gateway][Axios] request failed', {
      url: opts.url,
      method: opts.method,
      status,
      data,
      message,
    });
    const e = new Error(message);
    e.response = err.response;
    throw e;
  }
}

/* ---------- Controller actions ---------- */

// GET /transactions/:id
exports.getTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const { id } = req.params;
  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions/${encodeURIComponent(id)}`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditHeaders(req),
      params: req.query,
      timeout: 10000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      'Erreur lors du proxy GET transaction';
    logger.error('[Gateway][TX] Erreur GET transaction:', {
      status,
      error,
      provider,
      transactionId: id,
    });
    return res.status(status).json({ success: false, error });
  }
};

// GET /transactions
exports.listTransactions = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditHeaders(req),
      params: req.query,
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      'Erreur lors du proxy GET transactions';
    logger.error('[Gateway][TX] Erreur GET transactions:', { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
};

// POST /transactions/initiate
exports.initiateTransaction = async (req, res) => {
  const targetProvider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[targetProvider];
  const targetUrl = targetService
    ? String(targetService).replace(/\/+$/, '') + '/transactions/initiate'
    : null;

  logger.debug('[Gateway][TX] initiateTransaction targetUrl', {
    targetProvider,
    targetUrl,
  });

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Provider (destination) inconnu.',
    });
  }

  const userId = getUserId(req);
  const now = new Date();
  let reference = null;
  let statusResult = 'pending';

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
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
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Erreur interne provider';
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

    logger.error('[Gateway][TX] initiateTransaction failed', {
      provider: targetProvider,
      error,
      status,
    });
    return res.status(status).json({ success: false, error });
  }
};

// POST /transactions/confirm
exports.confirmTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const { transactionId } = req.body;
  const targetService = PROVIDER_TO_SERVICE[provider];
  const targetUrl = targetService
    ? String(targetService).replace(/\/+$/, '') + '/transactions/confirm'
    : null;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Provider (destination) inconnu.',
    });
  }

  const userId = getUserId(req);
  const now = new Date();

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
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
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Erreur interne provider';
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

    logger.error('[Gateway][TX] confirmTransaction failed', {
      provider,
      error,
      status,
    });
    return res.status(status).json({ success: false, error });
  }
};

// POST /transactions/cancel
exports.cancelTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const { transactionId } = req.body;
  const targetService = PROVIDER_TO_SERVICE[provider];
  const targetUrl = targetService
    ? String(targetService).replace(/\/+$/, '') + '/transactions/cancel'
    : null;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Provider (destination) inconnu.',
    });
  }

  const userId = getUserId(req);
  const now = new Date();

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
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
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Erreur interne provider';
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

    logger.error('[Gateway][TX] cancelTransaction failed', {
      provider,
      error,
      status,
    });
    return res.status(status).json({ success: false, error });
  }
};

/* Refund / Reassign / Validate / Archive / Relaunch share the same pattern */
exports.refundTransaction = async (req, res) =>
  forwardTransactionProxy(req, res, 'refund');
exports.reassignTransaction = async (req, res) =>
  forwardTransactionProxy(req, res, 'reassign');
exports.validateTransaction = async (req, res) =>
  forwardTransactionProxy(req, res, 'validate');
exports.archiveTransaction = async (req, res) =>
  forwardTransactionProxy(req, res, 'archive');
exports.relaunchTransaction = async (req, res) =>
  forwardTransactionProxy(req, res, 'relaunch');

/* Helper générique pour proxyer les actions simples */
async function forwardTransactionProxy(req, res, action) {
  const provider = resolveProvider(req, 'paynoval');
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res
      .status(400)
      .json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const url =
    String(targetService).replace(/\/+$/, '') + `/transactions/${action}`;

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url,
      data: req.body,
      headers: auditHeaders(req),
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const error =
      err.response?.data?.error ||
      err.message ||
      `Erreur proxy ${action}`;
    logger.error(`[Gateway][TX] Erreur ${action}:`, {
      status,
      error,
      provider,
    });
    return res.status(status).json({ success: false, error });
  }
}
