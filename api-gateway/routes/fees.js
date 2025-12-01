// routes/fees.js

const express = require('express');
const router = express.Router();

// ✅ Middleware admin existant
const requireAdmin = require('../src/middlewares/requireAdmin');

// ✅ Contrôleur des frais (dans /controllers)
const feesCtrl = require('../controllers/feesController');

/**
 * 🔓 Endpoint PUBLIC UNIQUE pour toute simulation de frais
 * GET /api/v1/fees/simulate
 *
 * - Accessible depuis le front (web/mobile) via l'API Gateway
 * - Accessible aussi depuis tes microservices (transactions, etc.)
 */
router.get('/simulate', feesCtrl.simulateFee);

/**
 * 🔐 Middleware combiné :
 *  - Si l'appel vient d'un microservice interne avec le bon x-internal-token,
 *    on laisse passer sans exiger de JWT admin.
 *  - Sinon, on tombe sur le requireAdmin classique (JWT admin/superadmin).
 */
const requireInternalOrAdmin = (req, res, next) => {
  const internalHeader = req.get('x-internal-token');

  // Appel interne de microservice (ex: api-paynoval -> gateway)
  if (
    internalHeader &&
    process.env.INTERNAL_TOKEN &&
    internalHeader === process.env.INTERNAL_TOKEN
  ) {
    return next();
  }

  // Sinon, on applique la logique admin habituelle (JWT admin)
  return requireAdmin(req, res, next);
};

// 👉 Toutes les routes ci-dessous sont protégées
router.use(requireInternalOrAdmin);

// Liste des frais
router.get('/', feesCtrl.getFees);

// Détail d’un frais par ID
router.get('/:id', feesCtrl.getFeeById);

// Création d’un nouveau profil de frais
router.post('/', feesCtrl.createFee);

// Mise à jour d’un profil de frais
router.put('/:id', feesCtrl.updateFee);

// Suppression d’un profil de frais
router.delete('/:id', feesCtrl.deleteFee);

module.exports = router;
