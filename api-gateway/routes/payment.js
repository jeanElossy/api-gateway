// routes/payment.js

const express = require('express');
const router = express.Router();
const validatePayment = require('../src/middlewares/validatePayment');
const amlMiddleware = require('../src/middlewares/aml');
const { handlePayment } = require('../controllers/paymentController');

// Route unique de paiement — front peut envoyer provider ou destination, les deux sont gérés.
router.post(
  '/',
  validatePayment,
  amlMiddleware,
  handlePayment
);

module.exports = router;
