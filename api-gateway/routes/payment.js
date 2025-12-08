// File: api-gateway/routes/payment.js

const express = require('express');
const router = express.Router();
const validatePayment = require('../src/middlewares/validatePayment');
const amlMiddleware = require('../src/middlewares/aml');
const { handlePayment } = require('../controllers/paymentController');

// POST /api/v1/pay
router.post('/', validatePayment, amlMiddleware, handlePayment);

module.exports = router;
