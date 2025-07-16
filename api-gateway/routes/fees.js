// src/routes/fees.routes.js

const express = require('express');
const router = express.Router();
const requireAdmin = require('../src/middlewares/requireAdmin');
const feesCtrl = require('../controllers/feesController');

// 👉 Endpoint public UNIQUE pour toute simulation de frais
router.get('/simulate', feesCtrl.simulateFee);

// Routes protégées (admin seulement)
router.use(requireAdmin);
router.get('/', feesCtrl.getFees);
router.get('/:id', feesCtrl.getFeeById);
router.post('/', feesCtrl.createFee);
router.put('/:id', feesCtrl.updateFee);
router.delete('/:id', feesCtrl.deleteFee);

module.exports = router;
