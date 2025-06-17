// routes/transactions.js

const express = require('express');
const amlMiddleware = require('../src/middlewares/aml');
const validateTransaction = require('../src/middlewares/validateTransaction');
const controller = require('../controllers/transactionsController');

const router = express.Router();

// Récupère toutes les transactions pour un provider (ex: ?provider=paynoval)
router.get('/', controller.listTransactions);

// INITIATE : Validation des données + AML + Contrôleur
router.post(
  '/initiate',
  validateTransaction('initiate'),
  amlMiddleware,
  controller.initiateTransaction
);

// CONFIRM : Validation des données + Contrôleur
router.post(
  '/confirm',
  validateTransaction('confirm'),
  controller.confirmTransaction
);

// CANCEL : Validation des données + Contrôleur
router.post(
  '/cancel',
  validateTransaction('cancel'),
  controller.cancelTransaction
);

module.exports = router;
