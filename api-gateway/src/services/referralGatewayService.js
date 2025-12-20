// File: api-gateway/src/services/referralGatewayService.js
'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../logger') || console;

// Token interne (fallback config.internalToken)
const INTERNAL_TOKEN =
  process.env.INTERNAL_TOKEN ||
  config.internalToken ||
  '';

/**
 * Base URL du service de parrainage :
 *  - idéalement via REFERRAL_SERVICE_URL (ex: https://backend-main.internal)
 *  - sinon fallback sur le microservice PayNoval configuré dans le Gateway
 */
const REFERRAL_SERVICE_BASE =
  (process.env.REFERRAL_SERVICE_URL &&
    process.env.REFERRAL_SERVICE_URL.replace(/\/+$/, '')) ||
  (config.microservices &&
    config.microservices.paynoval &&
    String(config.microservices.paynoval).replace(/\/+$/, '')) ||
  '';

if (!REFERRAL_SERVICE_BASE) {
  logger.warn(
    '[Gateway][Referral] REFERRAL_SERVICE_BASE non défini (REFERRAL_SERVICE_URL ou microservices.paynoval manquant). Les notifications de parrainage seront ignorées.'
  );
}

if (!INTERNAL_TOKEN) {
  logger.warn(
    '[Gateway][Referral] INTERNAL_TOKEN manquant. Vérifie que le même token est bien configuré côté backend /internal/referral.'
  );
}

/**
 * Notifie le service de parrainage qu'une transaction a été confirmée.
 *
 * ➜ Endpoint attendu côté backend/parrainage :
 *    POST /internal/referral/on-transaction-confirm
 */
async function notifyReferralOnConfirm({ userId, provider, transaction }) {
  if (!REFERRAL_SERVICE_BASE) {
    logger.warn('[Gateway][Referral] REFERRAL_SERVICE_BASE manquant, notification ignorée.');
    return;
  }

  if (!userId || !transaction || !transaction.id) {
    logger.warn(
      '[Gateway][Referral] payload incomplet (userId ou transaction.id manquant), notification ignorée.',
      { userId, provider, transactionId: transaction && transaction.id }
    );
    return;
  }

  const url = `${REFERRAL_SERVICE_BASE}/internal/referral/on-transaction-confirm`;

  try {
    await axios.post(
      url,
      { userId, provider, transaction },
      {
        timeout: 8000,
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': INTERNAL_TOKEN,
        },
      }
    );

    logger.info('[Gateway][Referral] notifyReferralOnConfirm OK', {
      userId,
      provider,
      txId: transaction.id,
      amount: transaction.amount,
      currency: transaction.currency,
    });
  } catch (err) {
    logger.error('[Gateway][Referral] notifyReferralOnConfirm ERROR', {
      url,
      userId,
      provider,
      txId: transaction.id,
      message: err.response?.data || err.message || err,
    });
    // ❗ On ne throw PAS : la transaction reste confirmée même si le bonus plante.
  }
}

module.exports = {
  notifyReferralOnConfirm,
};
