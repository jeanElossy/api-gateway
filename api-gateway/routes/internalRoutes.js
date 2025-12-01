// File: api-gateway/routes/internalRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const {
  handleInternalTransactionNotify,
} = require('../src/controllers/internalTransactionsController');

// ✅ chemin correct vers le middleware
const validateInternalToken = require('../src/middlewares/validateInternalToken');

// 🔐 Route appelée par api-paynoval pour déclencher emails/push
router.post(
  '/transactions/notify',
  validateInternalToken,           // vérifie x-internal-token
  handleInternalTransactionNotify
);

module.exports = router;
