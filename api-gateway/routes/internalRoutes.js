// File: api-gateway/routes/internalRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Logger + service de notifications déjà utilisés ailleurs dans le Gateway
const logger = require('../src/logger');
const { notifyTransactionEvent } = require('../src/services/transactionNotificationService');

// Middleware de sécurité interne (x-internal-token)
const validateInternalToken = require('../src/middlewares/validateInternalToken');

// ✅ Model Transaction Gateway (celui utilisé par /api/v1/transactions)
const Transaction = require('../src/models/Transaction');

function toObjectIdOrNull(v) {
  if (!v) return null;
  const s = String(v);
  return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Route interne appelée par api-paynoval pour notifier un évènement de transaction
 * (création, confirmation, annulation, etc.).
 *
 * URL: POST /api/v1/internal/transactions/notify
 * Protégée par : validateInternalToken  (header x-internal-token)
 */
router.post('/transactions/notify', validateInternalToken, async (req, res) => {
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
});

/**
 * ✅ Route interne appelée par tes backends (ex: cagnottes) pour LOGGER une tx
 *
 * URL: POST /api/v1/internal/transactions/log
 * Protégée par : validateInternalToken (header x-internal-token)
 *
 * Objectif:
 *  - éviter les 404 sur tes logs
 *  - stocker un historique central côté Gateway
 *  - idempotent (retry-safe) via upsert sur (provider, reference)
 */
router.post('/transactions/log', validateInternalToken, async (req, res) => {
  try {
    const b = req.body || {};

    const provider = String(b.provider || '').trim();
    const reference = String(b.reference || '').trim();

    if (!provider) {
      return res.status(400).json({ success: false, error: 'provider requis' });
    }
    if (!reference) {
      return res.status(400).json({ success: false, error: 'reference requis' });
    }

    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'amount invalide' });
    }

    // ✅ userId est REQUIRED dans ton schema => on valide strictement
    const userId = toObjectIdOrNull(b.userId);
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId invalide (ObjectId requis)',
      });
    }

    const createdBy = toObjectIdOrNull(b.createdBy);
    const receiver = toObjectIdOrNull(b.receiver);
    const ownerUserId = toObjectIdOrNull(b.ownerUserId);
    const initiatorUserId = toObjectIdOrNull(b.initiatorUserId);

    const currency = b.currency ? String(b.currency).trim().toUpperCase() : undefined;
    const status = b.status ? String(b.status).trim() : undefined;
    const operator = b.operator ? String(b.operator).trim() : undefined;
    const country = b.country ? String(b.country).trim() : undefined;

    const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
    const fees =
      typeof b.fees === 'number'
        ? b.fees
        : (typeof meta.feeAmount === 'number' ? meta.feeAmount : undefined);

    const netAmount =
      typeof b.netAmount === 'number'
        ? b.netAmount
        : (typeof meta.netToVault === 'number' ? meta.netToVault : undefined);

    const now = new Date();

    // ✅ Idempotent: upsert sur (provider, reference)
    const doc = await Transaction.findOneAndUpdate(
      { provider, reference },
      {
        $setOnInsert: {
          provider,
          reference,
          createdAt: now,
        },
        $set: {
          userId,
          ownerUserId: ownerUserId || undefined,
          initiatorUserId: initiatorUserId || undefined,
          createdBy: createdBy || undefined,
          receiver: receiver || undefined,

          amount,
          fees,
          netAmount,

          currency,
          operator,
          country,

          status,
          requiresSecurityValidation: !!b.requiresSecurityValidation,

          providerTxId: b.providerTxId ? String(b.providerTxId).trim() : undefined,
          meta: {
            ...meta,
            // ✅ garder une trace même si receiver/createdBy n'étaient pas ObjectId
            receiverRaw: b.receiver,
            createdByRaw: b.createdBy,
            userIdRaw: b.userId,
          },

          updatedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    logger.info('[Gateway][InternalLog] TX loggée', {
      provider,
      reference,
      _id: doc?._id,
      amount,
      currency,
      status,
    });

    return res.status(201).json({
      success: true,
      data: { _id: doc._id, reference: doc.reference },
    });
  } catch (err) {
    logger.error('[Gateway][InternalLog] Erreur log transaction', {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Erreur lors du log de la transaction.',
    });
  }
});

module.exports = router;
