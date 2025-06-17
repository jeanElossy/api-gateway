// routes/payment.js

const express = require('express');
const router = express.Router();
const validatePayment = require('../middlewares/validatePayment');
const amlMiddleware = require('../src/middlewares/aml');
const { handlePayment } = require('../controllers/paymentController');

router.post(
  '/',
  validatePayment,
  amlMiddleware,
  handlePayment
);

module.exports = router;
