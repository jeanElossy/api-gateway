// File: api-gateway/src/services/transactionNotificationRelay.js
'use strict';

/**
 * RELAIS DES NOTIFICATIONS TRANSACTIONNELLES VERS LE BACKEND PRINCIPAL
 * =============================================================================
 *
 * CE QUI A ÉTÉ SUPPRIMÉ, ET POURQUOI
 * -----------------------------------------------------------------------------
 * Ce fichier remplace `transactionNotificationService.js`, qui RENDAIT ici même
 * les e-mails de transaction. Le gateway embarquait pour cela sa propre copie de
 * `sendEmail.js` (SendGrid) et de `transactionEmailTemplates.js` — soit la
 * QUATRIÈME copie du même en-tête et du même pied de page dans le projet, dans
 * un dépôt distinct, avec ses propres couleurs et aucune traduction.
 *
 * Un e-mail parti par ce chemin ne ressemblait à aucun autre e-mail PayNoval.
 * Et comme la route n'a aucun appelant connu dans le workspace, l'écart pouvait
 * durer indéfiniment sans que personne le voie.
 *
 * Le gateway ne rend donc plus rien : il RELAIE vers le backend principal, seul
 * détenteur des gabarits. C'est déjà le rôle qu'il tient pour tout le reste.
 *
 * CE QUI N'A PAS CHANGÉ
 * -----------------------------------------------------------------------------
 * La signature `notifyTransactionEvent(payload)` et la forme de la charge utile
 * sont identiques : un appelant legacy n'a rien à modifier. La fonction ne lève
 * pas — un échec de notification ne doit pas faire échouer le flux appelant,
 * règle déjà appliquée par l'ancienne implémentation.
 */

const axios = require('axios');

let logger;
try {
  // eslint-disable-next-line global-require
  logger = require('../logger') || console;
} catch {
  logger = console;
}

const TIMEOUT_MS = Number(process.env.INTERNAL_RELAY_TIMEOUT_MS || 8000);

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

/** Base du backend principal, telle que le reste du gateway la résout déjà. */
function getPrincipalBaseUrl() {
  return stripTrailingSlash(
    process.env.PRINCIPAL_URL ||
      process.env.PRINCIPAL_API_BASE_URL ||
      ''
  );
}

/** Secret partagé avec le backend principal, avec le repli legacy historique. */
function getPrincipalToken() {
  return (
    process.env.PRINCIPAL_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    ''
  );
}

/**
 * Relaie un événement de transaction au backend principal, qui envoie les
 * e-mails.
 *
 * @param {object} payload { type, transaction, sender, receiver, reason?, links? }
 */
async function notifyTransactionEvent(payload) {
  const { type, transaction, sender, receiver } = payload || {};

  if (!transaction || (!sender?.email && !receiver?.email)) {
    logger.warn?.('[Gateway][notifyTransactionEvent] payload incomplet, ignoré.', {
      hasTx: !!transaction,
      hasSender: !!sender?.email,
      hasReceiver: !!receiver?.email,
    });
    return { ok: false, reason: 'INCOMPLETE_PAYLOAD' };
  }

  const base = getPrincipalBaseUrl();
  const token = getPrincipalToken();

  if (!base || !token) {
    // Explicite plutôt que silencieux : l'ancienne version se contentait de ne
    // rien envoyer quand la clé SendGrid manquait.
    logger.error?.(
      '[Gateway][notifyTransactionEvent] PRINCIPAL_URL ou PRINCIPAL_INTERNAL_TOKEN manquant — relais impossible.'
    );
    return { ok: false, reason: 'RELAY_NOT_CONFIGURED' };
  }

  const url = `${base}/api/v1/internal/transactions/notify`;

  try {
    const { data } = await axios.post(url, payload, {
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': token,
      },
    });

    logger.info?.(
      `[Gateway][notifyTransactionEvent] relayé (${type}) — ${transaction?.reference || transaction?.id || ''}`
    );

    return { ok: true, data };
  } catch (err) {
    // NE PAS lever : le flux appelant ne doit pas échouer parce qu'un e-mail
    // n'est pas parti.
    logger.error?.(
      '[Gateway][notifyTransactionEvent] relais en échec :',
      err?.response?.data || err?.message || err
    );

    return { ok: false, reason: err?.message || 'RELAY_FAILED' };
  }
}

module.exports = { notifyTransactionEvent, getPrincipalBaseUrl, getPrincipalToken };
