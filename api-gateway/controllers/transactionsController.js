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
const PRINCIPAL_URL = (
  config.principalUrl || process.env.PRINCIPAL_URL || ''
).replace(/\/+$/, '');

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
      // fallback
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
  if (clone.cardNumber) {
    clone.cardNumber = '****' + String(clone.cardNumber).slice(-4);
  }
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
 * - Forward Authorization seulement si présent et non "null"
 * - Toujours inclure x-internal-token pour auth inter-services
 * - Ajoute x-request-id généré si absent
 * - Propage x-user-id / x-session-id / x-device-id
 */
function auditForwardHeaders(req) {
  const incomingAuth =
    req.headers.authorization || req.headers.Authorization || null;
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
    const authPreview = headers.Authorization
      ? String(headers.Authorization).slice(0, 12)
      : null;
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

    const preview = typeof data === 'string' ? data.slice(0, 300) : data;
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
 */
async function creditAdminCommissionFromGateway({
  provider,
  kind,
  amount,
  currency,
  req,
}) {
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

    const authHeader =
      req.headers.authorization || req.headers.Authorization || null;
    const headers = {};
    if (
      authHeader &&
      String(authHeader).toLowerCase().startsWith('bearer ')
    ) {
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
    // ⚠️ On ne casse PAS la transaction si le crédit admin échoue
  }
}

/**
 * 🔔 Helper générique : déclenche les emails transactionnels
 */
async function triggerGatewayTxEmail(type, { provider, req, result, reference }) {
  try {
    if (provider === 'paynoval') {
      // Les emails internes PayNoval sont gérés par api-paynoval
      return;
    }

    const user = req.user || {};
    const senderEmail =
      user.email || user.username || req.body.senderEmail || null;
    const senderName =
      user.fullName || user.name || req.body.senderName || senderEmail;

    const receiverEmail =
      result.receiverEmail ||
      result.toEmail ||
      req.body.toEmail ||
      null;
    const receiverName =
      result.receiverName || req.body.receiverName || receiverEmail;

    if (!senderEmail && !receiverEmail) {
      logger.warn(
        '[Gateway][TX] triggerGatewayTxEmail: aucun email sender/receiver, skip.'
      );
      return;
    }

    const txId =
      result.transactionId || result.id || reference || null;

    const txReference = reference || result.reference || null;

    const amount = result.amount || req.body.amount || 0;

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
          ? `${frontendBase}/transactions/confirm/${encodeURIComponent(
              txId
            )}`
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
    return res
      .status(400)
      .json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const { id } = req.params;
  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions/${encodeURIComponent(id)}`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 10000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur GET transaction',
        {
          provider,
          transactionId: id,
          upstreamStatus: err.response?.status,
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      'Erreur lors du proxy GET transaction';

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

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
    return res
      .status(400)
      .json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const base = String(targetService).replace(/\/+$/, '');
  const url = `${base}/transactions`;

  try {
    const response = await safeAxiosRequest({
      method: 'get',
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 15000,
    });
    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur GET transactions',
        {
          provider,
          upstreamStatus: err.response?.status,
          path: '/transactions',
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      'Erreur lors du proxy GET transactions';

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    logger.error('[Gateway][TX] Erreur GET transactions:', {
      status,
      error,
      provider,
    });
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

  // 🔐 Sécurité obligatoire (question + code)
  const securityQuestion =
    (req.body.securityQuestion || req.body.question || '').trim();
  const securityCode = (req.body.securityCode || '').trim();

  if (!securityQuestion || !securityCode) {
    return res.status(400).json({
      success: false,
      error:
        'Question et code de sécurité obligatoires pour initier une transaction.',
    });
  }
  const securityCodeHash = hashSecurityCode(securityCode);

  try {
    const response = await safeAxiosRequest({
      method: 'post',
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
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

    // 🔔 EMAILS "initiated"
    await triggerGatewayTxEmail('initiated', {
      provider: targetProvider,
      req,
      result,
      reference,
    });

    // 💰 Commission admin globale pour tous les providers ≠ paynoval
    if (targetProvider !== 'paynoval') {
      try {
        const rawFee =
          (result &&
            (result.fees || result.fee || result.transactionFees)) ||
          null;

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
    if (err.isCloudflareChallenge) {
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur INITIATE',
        {
          provider: targetProvider,
          upstreamStatus: err.response?.status,
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
    }

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
  if (provider !== 'paynoval') {
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
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const result = response.data;

    let newStatus = result.status || 'confirmed';
    if (newStatus === 'cancelled') newStatus = 'canceled';

    const refFromResult =
      result.reference ||
      result.transaction?.reference ||
      req.body.reference ||
      null;

    const idFromResult =
      result.id || result.transaction?.id || transactionId || null;

    const candidates = Array.from(
      new Set(
        [refFromResult, idFromResult, transactionId]
          .filter(Boolean)
          .map(String)
      )
    );

    let query = { provider };
    if (candidates.length > 0) {
      query = {
        provider,
        $or: [
          ...candidates.map((v) => ({ reference: v })),
          ...candidates.map((v) => ({ 'meta.reference': v })),
          ...candidates.map((v) => ({ 'meta.id': v })),
        ],
      };
    }

    await AMLLog.create({
      userId,
      type: 'confirm',
      provider,
      amount: result.amount || 0,
      toEmail:
        result.recipientEmail || result.toEmail || result.email || '',
      details: cleanSensitiveMeta(req.body),
      flagged: false,
      flagReason: '',
      createdAt: now,
    });

    const gatewayTx = await Transaction.findOneAndUpdate(
      query,
      {
        $set: {
          status: newStatus,
          confirmedAt: newStatus === 'confirmed' ? now : undefined,
          updatedAt: now,
        },
      },
      { new: true }
    );

    if (!gatewayTx) {
      logger.warn(
        '[Gateway][TX] confirmTransaction: aucune transaction Gateway trouvée à mettre à jour',
        { provider, transactionId, refFromResult, candidates }
      );
    }

    await triggerGatewayTxEmail('confirmed', {
      provider,
      req,
      result,
      reference: refFromResult || transactionId,
    });

    // Parrainage
    if (newStatus === 'confirmed' && gatewayTx) {
      const authHeader =
        req.headers.authorization || req.headers.Authorization || null;
      const authToken =
        authHeader && String(authHeader).startsWith('Bearer ')
          ? authHeader
          : null;

      const referralUserId = gatewayTx.userId || userId;

      if (authToken && referralUserId) {
        await checkAndGenerateReferralCodeInMain(referralUserId, authToken);
        await processReferralBonusIfEligible(referralUserId, authToken);
      } else {
        logger.warn(
          '[Gateway][TX][Referral] Authorization manquant ou userId nul, parrainage ignoré.',
          { tokenPresent: !!authToken, referralUserId }
        );
      }
    }

    return res.status(response.status).json(result);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur CONFIRM',
        {
          provider,
          upstreamStatus: err.response?.status,
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.';
    }

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
        provider,
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
      headers: auditForwardHeaders(req),
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

    await triggerGatewayTxEmail('cancelled', {
      provider,
      req,
      result,
      reference: transactionId,
    });

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
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur CANCEL',
        {
          provider,
          upstreamStatus: err.response?.status,
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service de paiement temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      err.message ||
      'Erreur interne provider';

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

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

// POST /transactions/internal/log
exports.logInternalTransaction = async (req, res) => {
  try {
    // 🔐 Sécurité interne supplémentaire (en plus du middleware de route)
    const headerToken = req.headers['x-internal-token'] || '';
    const expectedToken =
      config.internalToken || process.env.INTERNAL_LOG_TOKEN || '';

    if (expectedToken && headerToken !== expectedToken) {
      logger.warn('[Gateway][TX] logInternalTransaction: token interne invalide');
      return res.status(401).json({
        success: false,
        error: 'Appel interne non autorisé.',
      });
    }

    const now = new Date();
    const userId = getUserId(req) || req.body.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId manquant pour loguer la transaction.',
      });
    }

    const {
      provider = 'paynoval',
      amount,
      status = 'confirmed',
      currency,
      operator = 'paynoval',
      country,
      reference,
      meta = {},
      createdBy,
      receiver,
      // 💸 frais internes (optionnels)
      fees,
      netAmount,
    } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'amount invalide ou manquant pour loguer la transaction.',
      });
    }

    const tx = await Transaction.create({
      userId,
      provider,
      amount: numAmount,
      status,
      currency,
      operator,
      country,
      reference,
      requiresSecurityValidation: false,
      securityAttempts: 0,
      securityLockedUntil: null,
      confirmedAt: status === 'confirmed' ? now : undefined,
      meta: cleanSensitiveMeta(meta),
      createdAt: now,
      updatedAt: now,
      createdBy: createdBy || userId,
      receiver: receiver || userId,
      // 💸 on stocke aussi les frais si envoyés par le microservice
      fees: typeof fees === 'number' ? fees : undefined,
      netAmount:
        typeof netAmount === 'number'
          ? netAmount
          : undefined,
    });

    return res.status(201).json({
      success: true,
      data: tx,
    });
  } catch (err) {
    logger.error('[Gateway][TX] logInternalTransaction error', {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la création de la transaction interne.',
    });
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
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    return res.status(response.status).json(response.data);
  } catch (err) {
    if (err.isCloudflareChallenge) {
      logger.error(
        '[Gateway][TX] Cloudflare challenge détecté sur action',
        {
          provider,
          action,
          upstreamStatus: err.response?.status,
        }
      );

      return res.status(503).json({
        success: false,
        error:
          'Service PayNoval temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === 'string'
        ? err.response.data
        : null) ||
      err.message ||
      `Erreur proxy ${action}`;

    if (status === 429) {
      error =
        'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
    }

    logger.error(`[Gateway][TX] Erreur ${action}:`, {
      status,
      error,
      provider,
    });
    return res.status(status).json({ success: false, error });
  }
}
