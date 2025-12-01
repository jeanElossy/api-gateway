// routes/fees.js

const express = require('express');
const router = express.Router();

// ✅ Chemin correct vers le middleware admin
const requireAdmin = require('../src/middlewares/requireAdmin');

// ✅ Contrôleur des frais (dans /controllers)
const feesCtrl = require('../controllers/feesController');

// 👉 Endpoint public UNIQUE pour toute simulation de frais
// GET /api/v1/fees/simulate
router.get('/simulate', feesCtrl.simulateFee);

// Routes protégées (admin seulement)
router.use(requireAdmin);

router.get('/', feesCtrl.getFees);
router.get('/:id', feesCtrl.getFeeById);
router.post('/', feesCtrl.createFee);
router.put('/:id', feesCtrl.updateFee);
router.delete('/:id', feesCtrl.deleteFee);

module.exports = router;
