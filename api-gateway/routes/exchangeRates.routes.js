const express = require('express');
const router = express.Router();
const exchangeRatesCtrl = require('../controllers/exchangeRatesController');

// 🔓 Endpoint public pour front (web / mobile)
router.get('/rate', exchangeRatesCtrl.getRatePublic);

module.exports = router;
