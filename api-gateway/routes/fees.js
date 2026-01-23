// // File: api-gateway/routes/fees.js
// 'use strict';

// const express = require('express');
// const router = express.Router();

// const config = require('../src/config');

// // ✅ Middleware admin existant
// const requireAdmin = require('../src/middlewares/requireAdmin');

// // ✅ Contrôleur des frais (dans /controllers)
// const feesCtrl = require('../controllers/feesController');

// /**
//  * 🔓 Endpoint PUBLIC UNIQUE pour toute simulation de frais
//  * GET /api/v1/fees/simulate
//  */
// router.get('/simulate', feesCtrl.simulateFee);

// /**
//  * 🔐 Middleware combiné :
//  *  - Si l'appel vient d'un microservice interne avec le bon x-internal-token,
//  *    on laisse passer sans exiger de JWT admin.
//  *  - Sinon, requireAdmin.
//  */
// const requireInternalOrAdmin = (req, res, next) => {
//   const internalHeader = req.get('x-internal-token');

//   const expectedInternal =
//     process.env.GATEWAY_INTERNAL_TOKEN ||
//     process.env.INTERNAL_TOKEN ||
//     config.internalToken ||
//     '';

//   if (internalHeader && expectedInternal && internalHeader === expectedInternal) {
//     return next();
//   }

//   return requireAdmin(req, res, next);
// };

// // 👉 Toutes les routes ci-dessous sont protégées
// router.use(requireInternalOrAdmin);

// // Liste des frais
// router.get('/', feesCtrl.getFees);

// // Détail d’un frais par ID
// router.get('/:id', feesCtrl.getFeeById);

// // Création d’un nouveau profil de frais
// router.post('/', feesCtrl.createFee);

// // Mise à jour d’un profil de frais
// router.put('/:id', feesCtrl.updateFee);

// // Suppression d’un profil de frais
// router.delete('/:id', feesCtrl.deleteFee);

// module.exports = router;




"use strict";

const express = require("express");
const router = express.Router();

const config = require("../src/config");
const requireAdmin = require("../src/middlewares/requireAdmin");
const feesCtrl = require("../controllers/feesController");

router.get("/simulate", feesCtrl.simulateFee);

const requireInternalOrAdmin = (req, res, next) => {
  const internalHeader = req.get("x-internal-token");
  const expectedInternal =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  if (internalHeader && expectedInternal && internalHeader === expectedInternal) return next();
  return requireAdmin(req, res, next);
};

router.use(requireInternalOrAdmin);

router.get("/", feesCtrl.getFees);
router.get("/:id", feesCtrl.getFeeById);
router.post("/", feesCtrl.createFee);
router.put("/:id", feesCtrl.updateFee);
router.delete("/:id", feesCtrl.deleteFee);

module.exports = router;
