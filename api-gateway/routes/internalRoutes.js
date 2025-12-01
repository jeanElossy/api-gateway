// File: api-gateway/routes/internalRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

// Logger + service de notifications déjà utilisés ailleurs dans le Gateway
const logger = require('../src/logger');
const { notifyTransactionEvent } = require('../src/services/transactionNotificationService');

// Middleware de sécurité interne (x-internal-token)
const validateInternalToken = require('../src/middlewares/validateInternalToken');

/**
 * Route interne appelée par api-paynoval pour notifier un évènement de transaction
 * (création, confirmation, annulation, etc.).
 *
 * URL: POST /api/v1/internal/transactions/notify
 * Protégée par : validateInternalToken  (header x-internal-token)
 */
router.post(
  '/transactions/notify',
  validateInternalToken,
  async (req, res) => {
    try {
      const payload = req.body || {};

      logger.info('[Gateway][InternalNotify] Reçu notification transaction', {
        type: payload.type,
        txId: payload.transaction?.id,
        ref: payload.transaction?.reference,
        sender: payload.sender?.email,
        receiver: payload.receiver?.email,
      });

      // On réutilise le même service que pour les autres providers
      await notifyTransactionEvent(payload);

      return res.status(200).json({ success: true });
    } catch (err) {
      logger.error('[Gateway][InternalNotify] Erreur traitement notification', {
        message: err.message,
        stack: err.stack,
      });
      return res.status(500).json({
        success: false,
        error: 'Erreur lors du traitement de la notification transaction.',
      });
    }
  }
);

module.exports = router;
