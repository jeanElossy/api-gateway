// File: api-gateway/controllers/paymentController.js
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const config = require('../src/config');
const logger = require('../src/logger');

/**
 * Nettoie les champs sensibles UNIQUEMENT pour les logs / meta.
 * ⚠️ IMPORTANT: on ne doit PAS nettoyer le body AVANT de forward,
 * sinon on casse les providers (cardNumber/cvc...) et/ou securityCode.
 */
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
 * Mapping rail → URL du microservice de paiement. Périmètre du 2026-09-08 :
 * `stripe`, `bank`, `stripe2momo` et `flutterwave` en ont été retirés.
 *
 * Un rail absent de cette table est refusé par `resolveProviderKey` — il n'est
 * pas routé « quelque part par défaut ».
 */
const PROVIDER_TO_ENDPOINT = {
  paynoval: `${config.microservices.paynoval}/pay`,
  mobilemoney: `${config.microservices.mobilemoney}/pay`,
  visa_direct: config.microservices.visa_direct
    ? `${config.microservices.visa_direct}/pay`
    : undefined,
};

/**
 * Safe request-id
 */
function safeRequestId(req) {
  return (
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))
  );
}

/**
 * Headers d’audit envoyés vers les microservices
 */
function auditHeaders(req) {
  const incomingAuth =
    req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== 'bearer null' &&
    String(incomingAuth).trim().toLowerCase() !== 'null';

  const headers = {
    Accept: 'application/json',
    'x-internal-token': config.internalToken || '',
    'x-request-id': safeRequestId(req),
    'x-user-id': req.user?._id || req.user?.id || req.headers['x-user-id'] || '',
    'x-session-id': req.headers['x-session-id'] || '',
  };

  if (hasAuth) {
    headers.Authorization = incomingAuth;
  }

  if (req.headers['x-device-id']) {
    headers['x-device-id'] = req.headers['x-device-id'];
  }

  return headers;
}

/**
 * Détection challenge Cloudflare (plus robuste)
 */
function isCloudflareChallengeResponse(response) {
  if (!response) return false;
  const status = response.status;
  const data = response.data;

  const suspiciousStatus = status === 403 || status === 429 || status === 503;
  if (!data || typeof data !== 'string') return false;

  const lower = data.toLowerCase();
  const looksLikeHtml = lower.includes('<html') || lower.includes('<!doctype html');
  const hasCfMarkers =
    lower.includes('just a moment') ||
    lower.includes('attention required') ||
    lower.includes('cdn-cgi/challenge-platform') ||
    lower.includes('__cf_chl_') ||
    lower.includes('cloudflare');

  return suspiciousStatus && (hasCfMarkers || looksLikeHtml);
}

/**
 * Détection du provider à partir du body
 */
function resolveProviderKey(body = {}) {
  if (body.provider && PROVIDER_TO_ENDPOINT[body.provider]) return body.provider;
  if (body.destination && PROVIDER_TO_ENDPOINT[body.destination]) return body.destination;
  return null;
}

/**
 * 🔗 URL de base du backend qui gère les cagnottes
 */
function getCagnottesBaseUrl() {
  const base = config.microservices.cagnottes || config.microservices.paynoval || '';
  return String(base || '').replace(/\/+$/, '');
}

/**
 * 🧮 Calcul dynamique des frais côté Gateway
 */
function computeDynamicFees(body = {}) {
  const provider = body.provider || body.destination || null;
  const context = body.context || body.operator || null;
  const rawAmount = Number(body.amount) || 0;

  if (!rawAmount || rawAmount <= 0) return null;

  // 🎯 Participation interne cagnotte PayNoval (wallet user → coffre)
  if (provider === 'paynoval' && context === 'cagnotte') {
    const rate = 0.005; // 0.5 %
    const feeAmount = Math.round(rawAmount * rate * 100) / 100;

    const currency =
      body.currency ||
      body.senderCurrencySymbol ||
      body.localCurrencySymbol ||
      null;

    return {
      feeRate: rate,
      feeAmount,
      feeCurrency: currency,
      feeKind: 'paynoval_internal_cagnotte',
    };
  }

  return null;
}

/**
 * Side-effect : informer le backend Cagnottes qu’un paiement
 * externe pour une cagnotte a été confirmé côté Gateway.
 *
 * ⚠️ NE S’APPLIQUE PAS aux paiements internes PayNoval
 */
async function notifyCagnotteExternalContribution(req, providerKey, providerResponse) {
  const { context, cagnotteId, cagnotteCode, donorName } = req.body || {};

  if (providerKey === 'paynoval') return;
  if (context !== 'cagnotte' || !cagnotteId) return;

  const baseUrl = getCagnottesBaseUrl();
  if (!baseUrl) {
    logger.warn('[PAYMENT→CAGNOTTE] URL backend cagnottes non configurée', {
      providerKey,
    });
    return;
  }

  const url = `${baseUrl}/api/v1/cagnottes/${cagnotteId}/external-payment-callback`;

  const amount = Number(req.body.amount) || 0;
  if (!amount || amount <= 0) {
    logger.warn('[PAYMENT→CAGNOTTE] Montant invalide pour cagnotte', {
      cagnotteId,
      amount: req.body.amount,
    });
    return;
  }

  const nom =
    donorName ||
    req.body.recipientName ||
    req.user?.fullName ||
    'Contributeur externe';

  const externalRef =
    providerResponse?.data?.reference ||
    providerResponse?.data?.id ||
    null;

  const payload = {
    amount,
    nom,
    status: 'succeeded',
    provider: providerKey,
    externalRef,
    codeParticipation: cagnotteCode || req.body.codeParticipation || undefined,
  };

  try {
    await axios.post(url, payload, {
      timeout: 8000,
      headers: {
        'x-gateway-token': process.env.CAGNOTTE_GATEWAY_TOKEN || '',
      },
    });

    logger.info('[PAYMENT→CAGNOTTE] Participation externe notifiée', {
      cagnotteId,
      amount,
      provider: providerKey,
      externalRef,
    });
  } catch (err) {
    logger.error('[PAYMENT→CAGNOTTE] Échec callback externe', {
      cagnotteId,
      provider: providerKey,
      error: err.response?.data || err.message,
    });
  }
}

exports.handlePayment = async (req, res) => {
  const providerKey = resolveProviderKey(req.body);
  const targetUrl = providerKey ? PROVIDER_TO_ENDPOINT[providerKey] : null;

  if (!targetUrl) {
    logger.error('[PAYMENT] Provider non supporté demandé', {
      provider: req.body?.provider,
      destination: req.body?.destination,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    return res.status(400).json({ error: 'Provider non supporté.' });
  }

  try {
    const dynamicFees = computeDynamicFees(req.body);

    // ✅ IMPORTANT: on forward le body ORIGINAL (pas cleanSensitiveMeta)
    const forwardBody = { ...(req.body || {}) };

    if (dynamicFees) {
      forwardBody.gatewayFee = dynamicFees.feeAmount;
      forwardBody.gatewayFeeRate = dynamicFees.feeRate;
      forwardBody.gatewayFeeCurrency = dynamicFees.feeCurrency;
      forwardBody.gatewayFeeKind = dynamicFees.feeKind;
    }

    // ✅ Timeout dynamique: PayNoval/cagnotte prennent plus de temps (cold start + DB)
    const isPaynoval = providerKey === 'paynoval';
    const isCagnotte = String(req.body?.context || '') === 'cagnotte';
    const timeoutMs = (isPaynoval || isCagnotte) ? 60_000 : 15_000;

    const response = await axios.post(targetUrl, forwardBody, {
      headers: auditHeaders(req),
      timeout: timeoutMs,
    });

    logger.info(`[PAYMENT→${providerKey}] Paiement réussi`, {
      provider: providerKey,
      amount: req.body?.amount,
      context: req.body?.context,
      targetType: req.body?.targetType,
      targetId: req.body?.targetId,
      status: response.status,
      user: req.user?.email || null,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      ref: response.data?.reference || response.data?.id || null,
      dynamicFees,
      timeoutMs,
      bodyPreview: cleanSensitiveMeta(req.body || {}),
    });

    // ✅ On répond AU CLIENT immédiatement (ne pas bloquer sur le side-effect)
    res.status(response.status).json(response.data);

    // fire-and-forget (sans casser la réponse)
    void notifyCagnotteExternalContribution(req, providerKey, response).catch((e) => {
      logger.error('[PAYMENT] Erreur side-effect cagnotte (async)', {
        provider: providerKey,
        error: e?.message,
      });
    });

    return;
  } catch (err) {
    // ✅ Timeout axios
    if (err.code === 'ECONNABORTED' || String(err.message || '').toLowerCase().includes('timeout')) {
      logger.error(`[PAYMENT→${providerKey}] Timeout vers microservice`, {
        provider: providerKey,
        targetUrl,
        message: err.message,
      });
      return res.status(504).json({
        error: `Timeout vers le service ${providerKey}. Merci de réessayer.`,
        details: 'timeout',
      });
    }

    if (err.response && isCloudflareChallengeResponse(err.response)) {
      logger.error(`[PAYMENT→${providerKey}] Cloudflare challenge détecté`, {
        status: err.response.status,
      });
      return res.status(503).json({
        error:
          'Service de paiement temporairement protégé par Cloudflare. Merci de réessayer dans quelques instants.',
        details: 'cloudflare_challenge',
      });
    }

    if (err.response) {
      const status = err.response.status;
      let errorMsg =
        err.response.data?.error ||
        err.response.data?.message ||
        `Erreur interne ${providerKey}`;

      if (status === 429) {
        errorMsg =
          'Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.';
      }

      logger.error(`[PAYMENT→${providerKey}] Échec API`, {
        provider: providerKey,
        status,
        data:
          typeof err.response.data === 'string'
            ? err.response.data.slice(0, 300)
            : err.response.data,
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        bodyPreview: cleanSensitiveMeta(req.body || {}),
      });

      return res.status(status).json({ error: errorMsg });
    }

    logger.error(`[PAYMENT→${providerKey}] Axios error: ${err.message}`, {
      provider: providerKey,
      targetUrl,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      bodyPreview: cleanSensitiveMeta(req.body || {}),
    });

    return res.status(502).json({
      error: `Service ${providerKey} temporairement indisponible.`,
    });
  }
};
