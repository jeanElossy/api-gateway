// routes/transactions.js

const express = require('express');
const amlMiddleware = require('../src/middlewares/aml');
const validateTransaction = require('../middlewares/validateTransaction');
const controller = require('../controllers/transactionsController');

const router = express.Router();

// Liste des transactions pour un provider (par défaut paynoval)
router.get('/', controller.listTransactions);

// INITIATE : Validation + AML + Controller
router.post(
  '/initiate',
  validateTransaction('initiate'),
  amlMiddleware,
  controller.initiateTransaction
);

// CONFIRM : Validation + Controller
router.post(
  '/confirm',
  validateTransaction('confirm'),
  controller.confirmTransaction
);

// CANCEL : Validation + Controller
router.post(
  '/cancel',
  validateTransaction('cancel'),
  controller.cancelTransaction
);

module.exports = router;
