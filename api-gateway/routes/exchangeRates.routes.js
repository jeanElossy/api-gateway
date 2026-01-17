// File: src/routes/exchangeRatesRoutes.js (exemple)
const express = require('express');
const router = express.Router();
const exchangeRatesCtrl = require('../controllers/exchangeRatesController');

router.get('/rate', exchangeRatesCtrl.getRatePublic);

module.exports = router;
