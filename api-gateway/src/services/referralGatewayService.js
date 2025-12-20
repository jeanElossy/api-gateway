// File: api-gateway/src/services/referralGatewayService.js
'use strict';

const axios = require('axios');
const config = require('../config');

let logger = console;
try {
  logger = require('../logger');
} catch {}

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || config.internalToken || '';
const PRINCIPAL_URL = (config.principalUrl || process.env.PRINCIPAL_URL || '').replace(/\/+$/, '');

if (!PRINCIPAL_URL) {
  logger.warn('[Gateway][Referral] PRINCIPAL_URL manquant (config.principalUrl / ENV PRINCIPAL_URL).');
}
if (!INTERNAL_TOKEN) {
  logger.warn('[Gateway][Referral] INTERNAL_TOKEN manquant, les actions referral internes seront ignorées.');
}

/** Petit helper pour éviter logs trop gros/sensibles */
function safeErrMessage(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;

  let msg =
    (typeof data === 'string' && data) ||
    (data && typeof data === 'object' && (data.error || data.message || JSON.stringify(data))) ||
    err?.message ||
    String(err);

  if (typeof msg === 'string' && msg.length > 450) msg = msg.slice(0, 450) + '…';
  return { status, msg };
}

function buildHeaders(extra = {}) {
  const base = {
    'Content-Type': 'application/json',
    ...extra,
  };

  // ✅ n’envoie pas un token vide
  if (INTERNAL_TOKEN) {
    base['x-internal-token'] = INTERNAL_TOKEN;
  }

  return base;
}

async function postWithFallback(paths, payload, requestId) {
  if (!PRINCIPAL_URL || !INTERNAL_TOKEN) return { ok: false, skipped: true };

  for (const p of paths) {
    const url = `${PRINCIPAL_URL}${p}`;
    try {
      const r = await axios.post(url, payload, {
        timeout: 8000,
        headers: buildHeaders(requestId ? { 'x-request-id': String(requestId) } : {}),
      });
      return { ok: true, data: r.data, path: p };
    } catch (err) {
      const { status, msg } = safeErrMessage(err);
      logger.warn('[Gateway][Referral] call failed', { url, status, message: msg });
    }
  }

  return { ok: false };
}

/**
 * ✅ 1) Génère/assure le code parrainage au 1er confirm
 * Le principal doit être idempotent (ne pas régénérer si déjà présent).
 */
async function notifyReferralOnConfirm({ userId, provider, transaction, requestId }) {
  if (!PRINCIPAL_URL || !INTERNAL_TOKEN) return;

  const txId = transaction?.id ? String(transaction.id) : '';
  const txRef = transaction?.reference ? String(transaction.reference) : '';

  if (!userId || (!txId && !txRef)) {
    logger.warn('[Gateway][Referral] notifyReferralOnConfirm payload incomplet', { userId, txId, txRef });
    return;
  }

  const payload = { userId, provider, transaction };

  const result = await postWithFallback(
    ['/internal/referral/on-transaction-confirm', '/api/v1/internal/referral/on-transaction-confirm'],
    payload,
    requestId
  );

  if (result.ok) {
    logger.info('[Gateway][Referral] referral code ensured', {
      userId,
      txId: txId || txRef,
      path: result.path,
    });
  } else {
    logger.error('[Gateway][Referral] notifyReferralOnConfirm FAILED', { userId, txId: txId || txRef });
  }
}

/**
 * ✅ 2) Déclenche bonus (parrain + filleul) une seule fois (idempotence principale côté backend)
 */
async function awardReferralBonus({ refereeId, triggerTxId, stats, requestId }) {
  if (!PRINCIPAL_URL || !INTERNAL_TOKEN) return { ok: false, skipped: true };

  if (!refereeId || !triggerTxId) {
    logger.warn('[Gateway][Referral] awardReferralBonus payload incomplet', { refereeId, triggerTxId });
    return { ok: false };
  }

  const payload = { refereeId, triggerTxId, stats };

  const result = await postWithFallback(
    ['/internal/referral/award-bonus', '/api/v1/internal/referral/award-bonus'],
    payload,
    requestId
  );

  if (result.ok) {
    logger.info('[Gateway][Referral] awardReferralBonus result', { refereeId, triggerTxId, response: result.data });
    return { ok: true, data: result.data };
  }

  logger.error('[Gateway][Referral] awardReferralBonus FAILED', { refereeId, triggerTxId });
  return { ok: false };
}

module.exports = {
  notifyReferralOnConfirm,
  awardReferralBonus,
};
