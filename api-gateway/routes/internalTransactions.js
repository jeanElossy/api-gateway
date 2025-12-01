// File: api-gateway/src/routes/internalTransactions.js
'use strict';

const express = require('express');
const router  = express.Router();

const logger = require('../logger') || console;
const { notifyTransactionEvent } = require('../services/transactionNotificationService');

/**
 * Middleware simple pour vérifier le token interne entre services.
 * On utilise l'en-tête: x-internal-token
 */
function requireInternalToken(req, res, next) {
  const configuredToken = process.env.INTERNAL_TOKEN;
  const incomingToken   = req.headers['x-internal-token'];

  if (!configuredToken) {
    // ⚠️ En prod tu DOIS en mettre un, mais on ne bloque pas sinon ça te casserait tout
    logger.warn(
      '[InternalTx] INTERNAL_TOKEN non défini. Les appels internes ne sont PAS protégés.'
    );
    return next();
  }

  if (!incomingToken || incomingToken !== configuredToken) {
    return res
      .status(403)
      .json({ success: false, error: 'Accès interne refusé (token invalide).' });
  }

  return next();
}

/**
 * POST /api/v1/internal/transactions/notify
 *
 * ➜ Appelé par api-paynoval (notifyGateway.js) pour envoyer :
 *  - type: "initiated" | "confirmed" | "cancelled"
 *  - transaction, sender, receiver, reason, links, ...
 *
 * Le service transactionNotificationService se charge
 * de construire les emails + envoyer via SendGrid.
 */
router.post('/notify', requireInternalToken, async (req, res) => {
  try {
    await notifyTransactionEvent(req.body);
    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error('[InternalTx] /notify ERROR', err.message || err);
    return res
      .status(500)
      .json({ success: false, error: 'Erreur interne Gateway' });
  }
});

module.exports = router;
