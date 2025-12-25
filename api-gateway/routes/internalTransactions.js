// File: api-gateway/routes/internalTransactions.js
'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

let logger = console;
try {
  // ✅ safe require
  logger = require('../src/logger');
} catch {}

// ✅ On réutilise le middleware officiel interne (même header x-internal-token)
const validateInternalToken = require('../src/middlewares/validateInternalToken');

const { notifyTransactionEvent } = require('../src/services/transactionNotificationService');
const Transaction = require('../src/models/Transaction');

function toObjectIdOrNull(v) {
  if (!v) return null;
  const s = String(v);
  return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * POST /internal/transactions/notify
 * Legacy route (non versionnée) – conservée pour compat.
 */
router.post('/notify', validateInternalToken, async (req, res) => {
  try {
    await notifyTransactionEvent(req.body);
    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error('[InternalTx] /notify ERROR', err.message || err);
    return res.status(500).json({ success: false, error: 'Erreur interne Gateway' });
  }
});

/**
 * ✅ POST /internal/transactions/log
 * Alias legacy pour compat avec anciens appels.
 * Recommande: utiliser /api/v1/internal/transactions/log à terme.
 */
router.post('/log', validateInternalToken, async (req, res) => {
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

    const doc = await Transaction.findOneAndUpdate(
      { provider, reference },
      {
        $setOnInsert: { provider, reference, createdAt: now },
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
            receiverRaw: b.receiver,
            createdByRaw: b.createdBy,
            userIdRaw: b.userId,
          },
          updatedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    return res.status(201).json({
      success: true,
      data: { _id: doc._id, reference: doc.reference },
    });
  } catch (err) {
    logger.error('[InternalTx] /log ERROR', err.message || err);
    return res.status(500).json({ success: false, error: 'Erreur interne Gateway' });
  }
});

module.exports = router;
