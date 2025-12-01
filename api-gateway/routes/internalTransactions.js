// File: api-gateway/src/routes/internalTransactions.js
'use strict';

const express = require('express');
const router = express.Router();
const { notifyTransactionEvent } = require('../services/transactionNotificationService');
const logger = require('../logger') || console;

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

function requireInternalToken(req, res, next) {
  const token = req.header('x-internal-token') || '';
  if (!INTERNAL_TOKEN || token !== INTERNAL_TOKEN) {
    logger.warn('[Gateway][InternalTX] Token interne invalide');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  return next();
}

// POST /internal/transactions/notify
router.post('/notify', requireInternalToken, async (req, res) => {
  try {
    await notifyTransactionEvent(req.body);
    return res.json({ success: true });
  } catch (err) {
    logger.error(
      '[Gateway][InternalTX] Erreur notify:',
      err.message || err
    );
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

module.exports = router;
