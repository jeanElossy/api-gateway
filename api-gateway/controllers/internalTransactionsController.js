// File: api-gateway/controllers/internalTransactionsController.js
'use strict';

const logger = require('../logger');
const { notifyTransactionEvent } = require('../services/transactionNotificationService');

/**
 * Reçoit les notifications venant de api-paynoval
 * et déclenche emails + push + in-app via notifyTransactionEvent.
 *
 * Appelée par: POST /api/v1/internal/transactions/notify
 */
exports.handleInternalTransactionNotify = async (req, res) => {
  try {
    const payload = req.body || {};

    logger.info('[Gateway][InternalNotify] Reçu notification transaction', {
      type: payload.type,
      txId: payload.transaction?.id,
      ref: payload.transaction?.reference,
      sender: payload.sender?.email,
      receiver: payload.receiver?.email,
    });

    // On utilise exactement le même service que pour les autres providers
    await notifyTransactionEvent(payload);

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error('[Gateway][InternalNotify] Erreur traitement notification', {
      message: err.message,
      stack: err.stack,
    });
    return res
      .status(500)
      .json({
        success: false,
        error: 'Erreur lors du traitement de la notification transaction.',
      });
  }
};
