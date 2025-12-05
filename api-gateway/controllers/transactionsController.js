// File: api-gateway/controllers/transactionsController.js
'use strict';

const axios = require('axios');
const config = require('../src/config');
const logger = require('../src/logger');
const Transaction = require('../src/models/Transaction');
const AMLLog = require('../src/models/AMLLog');
const crypto = require('crypto');

// ⬇️ service d’email transactionnel centralisé (SendGrid + templates)
const {
  notifyTransactionEvent,
} = require('../src/services/transactionNotificationService');

// ⬇️ service de parrainage appelé après chaque confirm
const {
  checkAndGenerateReferralCodeInMain,
  processReferralBonusIfEligible,
} = require('../src/utils/referralUtils');

// 🌐 Backend principal (API Users / Wallet / Notifications)
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(
  /\/+$/,
  ''
);

// 🧑‍💼 ID MongoDB de l’admin (admin@paynoval.com) – à configurer en ENV
// ex: ADMIN_USER_ID=6920a9528e93adc20e71d2cf
const ADMIN_USER_ID = config.adminUserId || process.env.ADMIN_USER_ID || null;

/**
 * Mapping centralisé des providers -> service URL
 * Ajoute ici toute nouvelle intégration (flutterwave, stripe, etc.)
 */
const PROVIDER_TO_SERVICE = {
  paynoval: config.microservices.paynoval,
  stripe: config.microservices.stripe,
  bank: config.microservices.bank,
  mobilemoney: config.microservices.mobilemoney,
  visa_direct: config.microservices.visa_direct,
  visadirect: config.microservices.visa_direct, // alias
  cashin: config.microservices.cashin,
  cashout: config.microservices.cashout,
  stripe2momo: config.microservices.stripe2momo,
  flutterwave: config.microservices.flutterwave, // NEW
};

/* Safe UUID helper (Node < 14 fallback) */
function safeUUID() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (e) {
      /* fallback */
    }
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
    ...(req.headers['x-device-id']
      ? { 'x-device-id': req.headers['x-device-id'] }
      : {}),
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

/**
 * Détection d’un challenge Cloudflare dans la réponse upstream
 * (cas que tu as dans les logs : 429 + HTML "Just a moment..." + cdn-cgi/challenge-platform)
 */
function isCloudflareChallengeResponse(response) {
  if (!response) return false;
  const status = response.status;
  const data = response.data;

  if (status !== 429 && status !== 403) return false;
  if (!data || typeof data !== 'string') return false;

  const lower = data.toLowerCase();

  return (
    lower.includes('just a moment') ||
    lower.includes('cdn-cgi/challenge-platform') ||
    lower.includes('__cf_chl_')
  );
}

/* Safe axios request wrapper that logs richer info on errors */
async function safeAxiosRequest(opts) {
  try {
    return await axios(opts);
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || null;
    const message = err.message || 'Unknown axios error';

    // On évite de pourrir les logs avec tout le HTML Cloudflare → on log juste un extrait
    const preview =
      typeof data === 'string' ? data.slice(0, 300) : data;

    const isCf = isCloudflareChallengeResponse(err.response);

    logger.error('[Gateway][Axios] request failed', {
      url: opts.url,
      method: opts.method,
      status,
      isCloudflare: isCf,
      dataPreview: preview,
      message,
    });

    const e = new Error(message);
    e.response = err.response;
    e.isCloudflareChallenge = isCf;
    throw e;
  }
}

/* Hash simple pour le code de sécurité (on n’a pas besoin de bcrypt côté Gateway) */
function hashSecurityCode(code) {
  return crypto
    .createHash('sha256')
    .update(String(code || '').trim())
    .digest('hex');
}

/**
 * 💰 Créditer la commission sur le compte admin dans le backend principal
 *
 * - amount : montant des frais (dans la devise currency)
 * - currency : devise des frais (CAD, XOF, etc.)
 * - kind : "transaction" | "cancellation" (pour les logs)
 * - provider : stripe, mobilemoney, visa_direct, ...
 */
async function creditAdminCommissionFromGateway({ provider, kind, amount, currency, req }) {
  try {
    if (!PRINCIPAL_URL || !ADMIN_USER_ID) {
      logger.warn(
        '[Gateway][Fees] PRINCIPAL_URL ou ADMIN_USER_ID manquant, commission admin non créditée.'
      );
      return;
    }

    const num = parseFloat(amount);
    if (!num || Number.isNaN(num) || num <= 0) {
      return;
    }

    const url = `${PRINCIPAL_URL}/users/${ADMIN_USER_ID}/credit`;

    // On propage le JWT du user si présent, sinon on laisse vide
    const authHeader = req.headers.authorization || req.headers.Authorization || null;
    const headers = {};
    if (authHeader && String(authHeader).startsWith('Bearer ')) {
      headers.Authorization = authHeader;
    }

    const description = `Commission PayNoval (${kind}) - provider=${provider}`;

    await axios.post(
      url,
      {
        amount: num,
        currency: currency || 'CAD',
        description,
      },
      { headers }
    );

    logger.info('[Gateway][Fees] Crédit admin OK', {
      provider,
      kind,
      amount: num,
      currency: currency || 'CAD',
      adminUserId: ADMIN_USER_ID,
    });
  } catch (err) {
    logger.error('[Gateway][Fees] Échec crédit admin', {
      provider,
      kind,
      amount,
      currency,
      message: err.message,
    });
    // ⚠️ très important : on ne casse PAS la transaction si le crédit admin échoue
  }
}

/**
 * 🔔 Helper générique : déclenche les emails transactionnels
 *   pour TOUS les providers via le service transactionNotificationService.
 *
 *   - Pour PayNoval interne, les emails peuvent déjà être déclenchés
 *     par api-paynoval via notifyGateway.js (→ /internal/transactions/notify).
 *     On évite donc un double envoi ici.
 */
async function triggerGatewayTxEmail(type, { provider, req, result, reference }) {
  try {
    if (provider === 'paynoval') {
      // Les emails internes PayNoval sont gérés par api-paynoval → /internal/transactions/notify
      return;
    }

    const user = req.user || {};
    const senderEmail =
      user.email ||
      user.username ||
      req.body.senderEmail ||
      null;
    const senderName =
      user.fullName ||
      user.name ||
      req.body.senderName ||
      senderEmail;

    const receiverEmail =
      result.receiverEmail ||
      result.toEmail ||
      req.body.toEmail ||
      null;
    const receiverName =
      result.receiverName ||
      req.body.receiverName ||
      receiverEmail;

    if (!senderEmail && !receiverEmail) {
      logger.warn('[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.');
      return;
    }

    const txId =
      result.transactionId ||
      result.id ||
      reference ||
      null;

    const txReference =
      reference ||
      result.reference ||
      null;

    const amount =
      result.amount ||
      req.body.amount ||
      0;

    const currency =
      result.currency ||
      req.body.currency ||
      req.body.senderCurrencySymbol ||
      req.body.localCurrencySymbol ||
      '---';

    const frontendBase =
      config.frontendUrl ||
      config.frontUrl ||
      (Array.isArray(config.cors?.origins) && config.cors.origins[0]) ||
      'https://www.paynoval.com';

    const payload = {
      type,
      provider,
      transaction: {
        id: txId,
        reference: txReference,
        amount,
        currency,
        dateIso: new Date().toISOString(),
      },
      sender: {
        email: senderEmail,
        name: senderName || senderEmail,
      },
      receiver: {
        email: receiverEmail,
        name: receiverName || receiverEmail,
      },
      reason:
        type === 'cancelled'
          ? result.reason || req.body.reason || ''
          : undefined,
      links: {
        sender: `${frontendBase}/transactions`,
        receiverConfirm: txId
          ? `${frontendBase}/transactions/confirm/${encodeURIComponent(txId)}`
          : '',
      },
    };

    await notifyTransactionEvent(payload);
    logger.info('[Gateway][TX] triggerGatewayTxEmail OK', {
      type,
      provider,
      txId,
      senderEmail,
      receiverEmail,
    });
  } catch (err) {
    logger.error('[Gateway][TX] triggerGatewayTxEmail ERROR', {
      type,
      provider,
      message: err.message,
    });
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
    // 🔎 Gestion spécifique Cloudflare 429/403
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transaction', {
        provider,
        transactionId: id,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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
    // 🔎 Gestion spécifique Cloudflare 429/403
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur GET transactions', {
        provider,
        upstreamStatus: err.response?.status,
        path: '/transactions',
      });

      // On NE renvoie PAS 429 à l’app (sinon confusion avec ton rateLimit),
      // mais un 503 explicite.
      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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

  // 🔐 Sécurité obligatoire comme dans api-paynoval (question + code)
  // On accepte soit securityQuestion, soit question (compat front)
  const securityQuestion =
    (req.body.securityQuestion || req.body.question || '').trim();
  const securityCode = (req.body.securityCode || '').trim();

  if (!securityQuestion || !securityCode) {
    return res.status(400).json({
      success: false,
      error: 'Question et code de sécurité obligatoires pour initier une transaction.',
    });
  }
  const securityCodeHash = hashSecurityCode(securityCode);

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
      currency:
        req.body.currency ||
        req.body.senderCurrencySymbol ||
        req.body.localCurrencySymbol ||
        undefined,
      operator: req.body.operator || undefined,
      country: req.body.country || undefined,
      reference,
      meta: cleanSensitiveMeta(req.body),
      createdAt: now,
      updatedAt: now,

      // 🔐 sécurité côté Gateway pour tous les providers
      requiresSecurityValidation: true,
      securityQuestion,
      securityCodeHash,
      securityAttempts: 0,
      securityLockedUntil: null,
    });

    // 🔔 EMAILS "initiated" pour TOUS les providers (sauf PayNoval interne)
    await triggerGatewayTxEmail('initiated', {
      provider: targetProvider,
      req,
      result,
      reference,
    });

    // 💰 Commission admin globale pour tous les providers ≠ paynoval
    if (targetProvider !== 'paynoval') {
      try {
        // On essaie de récupérer les frais renvoyés par le microservice
        const rawFee =
          (result && (result.fees || result.fee || result.transactionFees)) || null;

        if (rawFee) {
          const feeAmount = parseFloat(rawFee);
          if (!Number.isNaN(feeAmount) && feeAmount > 0) {
            const feeCurrency =
              result.feeCurrency ||
              result.currency ||
              req.body.currency ||
              req.body.senderCurrencySymbol ||
              req.body.localCurrencySymbol ||
              'CAD';

            await creditAdminCommissionFromGateway({
              provider: targetProvider,
              kind: 'transaction',
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        } else {
          logger.debug(
            '[Gateway][Fees] Aucun champ fees/fee/transactionFees dans la réponse provider, commission admin non calculée.',
            { provider: targetProvider }
          );
        }
      } catch (e) {
        logger.error('[Gateway][Fees] Erreur crédit admin (initiate)', {
          provider: targetProvider,
          message: e.message,
        });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    // Cloudflare sur initiate → même logique : on renvoie 503 propre
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur INITIATE', {
        provider: targetProvider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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
      currency:
        req.body.currency ||
        req.body.senderCurrencySymbol ||
        req.body.localCurrencySymbol ||
        undefined,
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

// // POST /transactions/confirm
// exports.confirmTransaction = async (req, res) => {
//   const provider = resolveProvider(req, 'paynoval');
//   const { transactionId, securityCode } = req.body;
//   const targetService = PROVIDER_TO_SERVICE[provider];
//   const targetUrl = targetService
//     ? String(targetService).replace(/\/+$/, '') + '/transactions/confirm'
//     : null;

//   if (!targetUrl) {
//     return res.status(400).json({
//       success: false,
//       error: 'Provider (destination) inconnu.',
//     });
//   }

//   const userId = getUserId(req);
//   const now = new Date();

//   // 🔐 Sécurité côté Gateway pour tous les providers ≠ paynoval
//   // (pour paynoval, la sécurité question/code est gérée dans api-paynoval)
//   if (provider !== 'paynoval') {
//     // On retrouve la transaction Gateway via la référence
//     const txRecord = await Transaction.findOne({
//       provider,
//       reference: transactionId,
//     });

//     if (!txRecord) {
//       return res.status(404).json({
//         success: false,
//         error: 'Transaction non trouvée dans le Gateway.',
//       });
//     }

//     if (txRecord.status !== 'pending') {
//       return res.status(400).json({
//         success: false,
//         error: 'Transaction déjà traitée ou annulée.',
//       });
//     }

//     if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
//       if (
//         txRecord.securityLockedUntil &&
//         txRecord.securityLockedUntil > now
//       ) {
//         return res.status(423).json({
//           success: false,
//           error:
//             'Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.',
//         });
//       }

//       if (!securityCode) {
//         return res.status(400).json({
//           success: false,
//           error: 'securityCode requis pour confirmer cette transaction.',
//         });
//       }

//       const incomingHash = hashSecurityCode(securityCode);

//       if (incomingHash !== txRecord.securityCodeHash) {
//         const attempts = (txRecord.securityAttempts || 0) + 1;

//         const update = {
//           securityAttempts: attempts,
//           updatedAt: now,
//         };

//         let errorMsg;
//         if (attempts >= 3) {
//           update.status = 'canceled';
//           update.cancelledAt = now;
//           update.cancelReason = 'Code de sécurité erroné (trop d’essais)';
//           update.securityLockedUntil = new Date(
//             now.getTime() + 15 * 60 * 1000
//           );
//           errorMsg =
//             'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.';

//           // Tu peux aussi déclencher ici un email 'cancelled' si besoin
//           await triggerGatewayTxEmail('cancelled', {
//             provider,
//             req,
//             result: {
//               ...txRecord.toObject(),
//               status: 'canceled',
//               amount: txRecord.amount,
//               toEmail: txRecord.toEmail,
//             },
//             reference: transactionId,
//           });
//         } else {
//           const remaining = 3 - attempts;
//           errorMsg = `Code de sécurité incorrect. Il vous reste ${remaining} essai(s).`;
//         }

//         await Transaction.updateOne({ _id: txRecord._id }, { $set: update });
//         return res.status(401).json({ success: false, error: errorMsg });
//       }

//       // Code OK → reset des tentatives
//       await Transaction.updateOne(
//         { _id: txRecord._id },
//         {
//           $set: {
//             securityAttempts: 0,
//             securityLockedUntil: null,
//             updatedAt: now,
//           },
//         }
//       );
//     }
//   }

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

//     // Mise à jour de la transaction dans le Gateway
//     await Transaction.findOneAndUpdate(
//       {
//         $or: [
//           { reference: transactionId },
//           { 'meta.reference': transactionId },
//           { 'meta.id': transactionId },
//         ],
//       },
//       {
//         $set: {
//           status: newStatus,
//           confirmedAt: newStatus === 'confirmed' ? now : undefined,
//           updatedAt: now,
//         },
//       }
//     );

//     // 🔔 EMAILS "confirmed" pour TOUS les providers (sauf PayNoval interne qui envoie déjà via notifyGateway.js)
//     await triggerGatewayTxEmail('confirmed', {
//       provider,
//       req,
//       result,
//       reference: transactionId,
//     });

//     // 🎁 PARRAINAGE GLOBAL : calculé dans le Gateway pour tous les providers
//     if (newStatus === 'confirmed') {
//       const txForReferral = {
//         id:
//           result.transactionId ||
//           result.id ||
//           transactionId,
//         reference: result.reference || transactionId,
//         amount: result.amount || req.body.amount || 0,
//         currency:
//           result.currency ||
//           req.body.currency ||
//           req.body.senderCurrencySymbol ||
//           req.body.localCurrencySymbol ||
//           '---',
//         country: result.country || req.body.country || undefined,
//         provider,
//         confirmedAt: new Date().toISOString(),
//       };

//       // Récupération du JWT pour appeler l’API principale (users, notifications, etc.)
//       const authHeader =
//         req.headers.authorization || req.headers.Authorization || null;
//       const authToken =
//         authHeader && String(authHeader).startsWith('Bearer ')
//           ? authHeader
//           : null;

//       if (authToken && userId) {
//         // 1) Génération éventuelle du referralCode (à partir de 2 tx confirmées)
//         await checkAndGenerateReferralCodeInMain(userId, authToken);

//         // 2) Bonus parrainage (1ʳᵉ vraie transaction confirmée)
//         await processReferralBonusIfEligible(userId, txForReferral, authToken);
//       } else {
//         logger.warn(
//           '[Gateway][TX][Referral] Authorization manquant ou userId nul, parrainage ignoré.'
//         );
//       }
//     }

//     return res.status(response.status).json(result);
//   } catch (err) {
//     if (err.isCloudflareChallenge) {
//       logger.error('[Gateway][TX] Cloudflare challenge détecté sur CONFIRM', {
//         provider,
//         upstreamStatus: err.response?.status,
//       });

//       return res.status(503).json({
//         success: false,
//         error:
//           "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
//         details: 'cloudflare_challenge',
//       });
//     }

//     const error =
//       err.response?.data?.error ||
//       err.response?.data?.message ||
//       err.message ||
//       'Erreur interne provider';
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

//     logger.error('[Gateway][TX] confirmTransaction failed', {
//       provider,
//       error,
//       status,
//     });
//     return res.status(status).json({ success: false, error });
//   }
// };

// POST /transactions/confirm
exports.confirmTransaction = async (req, res) => {
  const provider = resolveProvider(req, 'paynoval');
  const { transactionId, securityCode } = req.body;
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

  // 🔐 Sécurité côté Gateway pour tous les providers ≠ paynoval
  // (pour paynoval, la sécurité question/code est gérée dans api-paynoval)
  if (provider !== 'paynoval') {
    // On retrouve la transaction Gateway via la référence
    const txRecord = await Transaction.findOne({
      provider,
      reference: transactionId,
    });

    if (!txRecord) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée dans le Gateway.',
      });
    }

    if (txRecord.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: 'Transaction déjà traitée ou annulée.',
      });
    }

    if (txRecord.requiresSecurityValidation && txRecord.securityCodeHash) {
      if (
        txRecord.securityLockedUntil &&
        txRecord.securityLockedUntil > now
      ) {
        return res.status(423).json({
          success: false,
          error:
            'Transaction temporairement bloquée suite à des tentatives infructueuses. Réessayez plus tard.',
        });
      }

      if (!securityCode) {
        return res.status(400).json({
          success: false,
          error: 'securityCode requis pour confirmer cette transaction.',
        });
      }

      const incomingHash = hashSecurityCode(securityCode);

      if (incomingHash !== txRecord.securityCodeHash) {
        const attempts = (txRecord.securityAttempts || 0) + 1;

        const update = {
          securityAttempts: attempts,
          updatedAt: now,
        };

        let errorMsg;
        if (attempts >= 3) {
          update.status = 'canceled';
          update.cancelledAt = now;
          update.cancelReason = 'Code de sécurité erroné (trop d’essais)';
          update.securityLockedUntil = new Date(
            now.getTime() + 15 * 60 * 1000
          );
          errorMsg =
            'Code de sécurité incorrect. Nombre d’essais dépassé, transaction annulée.';

          // Tu peux aussi déclencher ici un email 'cancelled' si besoin
          await triggerGatewayTxEmail('cancelled', {
            provider,
            req,
            result: {
              ...txRecord.toObject(),
              status: 'canceled',
              amount: txRecord.amount,
              toEmail: txRecord.toEmail,
            },
            reference: transactionId,
          });
        } else {
          const remaining = 3 - attempts;
          errorMsg = `Code de sécurité incorrect. Il vous reste ${remaining} essai(s).`;
        }

        await Transaction.updateOne({ _id: txRecord._id }, { $set: update });
        return res.status(401).json({ success: false, error: errorMsg });
      }

      // Code OK → reset des tentatives
      await Transaction.updateOne(
        { _id: txRecord._id },
        {
          $set: {
            securityAttempts: 0,
            securityLockedUntil: null,
            updatedAt: now,
          },
        }
      );
    }
  }

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

    // Mise à jour de la transaction dans le Gateway
    await Transaction.findOneAndUpdate(
      {
        $or: [
          { reference: transactionId },
          { 'meta.reference': transactionId },
          { 'meta.id': transactionId },
        ],
      },
      {
        $set: {
          status: newStatus,
          confirmedAt: newStatus === 'confirmed' ? now : undefined,
          updatedAt: now,
        },
      }
    );

    // 🔔 EMAILS "confirmed" pour TOUS les providers (sauf PayNoval interne qui envoie déjà via notifyGateway.js)
    await triggerGatewayTxEmail('confirmed', {
      provider,
      req,
      result,
      reference: transactionId,
    });

    // 🎁 PARRAINAGE GLOBAL : calculé dans le Gateway pour tous les providers
    if (newStatus === 'confirmed') {
      // Récupération du JWT pour appeler l’API principale (users, notifications, etc.)
      const authHeader =
        req.headers.authorization || req.headers.Authorization || null;
      const authToken =
        authHeader && String(authHeader).startsWith('Bearer ')
          ? authHeader
          : null;

      if (authToken && userId) {
        // 1) Génération éventuelle du referralCode (à partir de 2 tx confirmées)
        await checkAndGenerateReferralCodeInMain(userId, authToken);

        // 2) Bonus parrainage :
        //    - basé sur la somme des 2 premières transactions confirmées du filleul
        //    - seuil selon la région du filleul
        //    - bonus et devise selon la région du parrain
        await processReferralBonusIfEligible(userId, authToken);
      } else {
        logger.warn(
          '[Gateway][TX][Referral] Authorization manquant ou userId nul, parrainage ignoré.'
        );
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur CONFIRM', {
        provider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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
      {
        $set: {
          status: newStatus,
          cancelledAt: now,
          cancelReason: req.body.reason || result.reason || '',
          updatedAt: now,
        },
      }
    );

    // 🔔 EMAILS "cancelled" pour tous les providers (sauf PayNoval via notifyGateway.js)
    await triggerGatewayTxEmail('cancelled', {
      provider,
      req,
      result,
      reference: transactionId,
    });

    // 💰 Commission admin sur frais d’annulation pour providers ≠ paynoval
    if (provider !== 'paynoval') {
      try {
        const rawCancellationFee =
          result.cancellationFeeInSenderCurrency ||
          result.cancellationFee ||
          result.fees ||
          null;

        if (rawCancellationFee) {
          const feeAmount = parseFloat(rawCancellationFee);
          if (!Number.isNaN(feeAmount) && feeAmount > 0) {
            const feeCurrency =
              result.adminCurrency ||
              result.currency ||
              req.body.currency ||
              req.body.senderCurrencySymbol ||
              'CAD';

            await creditAdminCommissionFromGateway({
              provider,
              kind: 'cancellation',
              amount: feeAmount,
              currency: feeCurrency,
              req,
            });
          }
        } else {
          logger.debug(
            '[Gateway][Fees] Aucun champ cancellationFee*/fees dans la réponse provider, pas de commission admin.',
            { provider }
          );
        }
      } catch (e) {
        logger.error('[Gateway][Fees] Erreur crédit admin (cancel)', {
          provider,
          message: e.message,
        });
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur CANCEL', {
        provider,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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

    // Si un jour tu veux des emails / parrainage aussi pour refund/validate/etc.,
    // tu pourras réutiliser ici triggerGatewayTxEmail + notifyReferralOnConfirm.

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error('[Gateway][TX] Cloudflare challenge détecté sur action', {
        provider,
        action,
        upstreamStatus: err.response?.status,
      });

      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.",
        details: 'cloudflare_challenge',
      });
    }

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



