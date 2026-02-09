




// // File: api-gateway/routes/transactions.js
// 'use strict';

// const express = require('express');
// const crypto = require('crypto');

// const amlMiddleware = require('../src/middlewares/aml');
// const validateTransaction = require('../src/middlewares/validateTransaction');
// const controller = require('../controllers/transactionsController');
// const { requireRole } = require('../src/middlewares/authz');
// const config = require('../src/config');

// const router = express.Router();

// /**
//  * Vérification du token interne pour les appels techniques (GATEWAY)
//  * - compare constant-time
//  * - accepte string/array
//  */
// function verifyInternalToken(req, res, next) {
//   const headerTokenRaw = req.headers['x-internal-token'];
//   const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : (headerTokenRaw || '');

//   const expectedToken =
//     process.env.GATEWAY_INTERNAL_TOKEN ||
//     process.env.INTERNAL_TOKEN ||
//     config.internalToken ||
//     '';

//   if (!expectedToken) {
//     return res.status(401).json({ success: false, error: 'Non autorisé (internal token absent côté serveur).' });
//   }

//   const a = Buffer.from(String(headerToken).trim());
//   const b = Buffer.from(String(expectedToken).trim());

//   // length must match for timingSafeEqual
//   const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

//   if (!ok) {
//     return res.status(401).json({ success: false, error: 'Non autorisé (internal token invalide).' });
//   }

//   return next();
// }

// // LIST toutes les transactions
// router.get('/', controller.listTransactions);

// // GET une transaction
// router.get('/:id', controller.getTransaction);

// // INITIATE : Validation + AML + proxy
// router.post(
//   '/initiate',
//   validateTransaction('initiate'),
//   amlMiddleware,
//   controller.initiateTransaction
// );


// // CONFIRM
// router.post('/confirm', validateTransaction('confirm'), controller.confirmTransaction);

// // CANCEL
// router.post('/cancel', validateTransaction('cancel'), controller.cancelTransaction);

// // REFUND : réservé admin/superadmin
// router.post('/refund', requireRole(['admin', 'superadmin']), validateTransaction('refund'), controller.refundTransaction);

// // REASSIGN : réservé admin/superadmin
// router.post('/reassign', requireRole(['admin', 'superadmin']), validateTransaction('reassign'), controller.reassignTransaction);

// // VALIDATE : réservé admin/superadmin
// router.post('/validate', requireRole(['admin', 'superadmin']), validateTransaction('validate'), controller.validateTransaction);

// // ARCHIVE : réservé admin/superadmin
// router.post('/archive', requireRole(['admin', 'superadmin']), validateTransaction('archive'), controller.archiveTransaction);

// // RELAUNCH : réservé admin/superadmin
// router.post('/relaunch', requireRole(['admin', 'superadmin']), validateTransaction('relaunch'), controller.relaunchTransaction);

// // 🔐 Log interne (cagnotte participation, etc.)
// router.post('/internal/log', verifyInternalToken, controller.logInternalTransaction);

// module.exports = router;






"use strict";

const express = require("express");
const crypto = require("crypto");

const amlMiddleware = require("../src/middlewares/aml");
const validateTransaction = require("../src/middlewares/validateTransaction");
const controller = require("../controllers/transactionsController");
const { requireRole } = require("../src/middlewares/authz");

// ✅ config path robuste
let config = null;
try {
  config = require("../src/config");
} catch {
  config = require("../config");
}

const router = express.Router();

/**
 * Vérification du token interne pour les appels techniques (GATEWAY)
 * - compare constant-time
 * - accepte string/array
 */
function verifyInternalToken(req, res, next) {
  const headerTokenRaw = req.headers["x-internal-token"];
  const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw || "";

  const expectedToken =
    process.env.GATEWAY_INTERNAL_TOKEN || process.env.INTERNAL_TOKEN || config?.internalToken || "";

  if (!expectedToken) {
    return res
      .status(401)
      .json({ success: false, error: "Non autorisé (internal token absent côté serveur)." });
  }

  const a = Buffer.from(String(headerToken).trim());
  const b = Buffer.from(String(expectedToken).trim());

  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.status(401).json({ success: false, error: "Non autorisé (internal token invalide)." });
  }

  return next();
}

// LIST toutes les transactions (proxy vers service + normalisation)
router.get("/", controller.listTransactions);

// GET une transaction (proxy + normalisation)
router.get("/:id", controller.getTransaction);

// INITIATE : Validation + AML + proxy (OTP guard reste dans controller)
router.post("/initiate", validateTransaction("initiate"), amlMiddleware, controller.initiateTransaction);

// CONFIRM (proxy)
router.post("/confirm", validateTransaction("confirm"), controller.confirmTransaction);

// CANCEL (proxy)
router.post("/cancel", validateTransaction("cancel"), controller.cancelTransaction);

// REFUND : réservé admin/superadmin (proxy)
router.post("/refund", requireRole(["admin", "superadmin"]), validateTransaction("refund"), controller.refundTransaction);

// REASSIGN : réservé admin/superadmin (proxy)
router.post(
  "/reassign",
  requireRole(["admin", "superadmin"]),
  validateTransaction("reassign"),
  controller.reassignTransaction
);

// VALIDATE : réservé admin/superadmin (proxy)
router.post(
  "/validate",
  requireRole(["admin", "superadmin"]),
  validateTransaction("validate"),
  controller.validateTransaction
);

// ARCHIVE : réservé admin/superadmin (proxy)
router.post(
  "/archive",
  requireRole(["admin", "superadmin"]),
  validateTransaction("archive"),
  controller.archiveTransaction
);

// RELAUNCH : réservé admin/superadmin (proxy)
router.post(
  "/relaunch",
  requireRole(["admin", "superadmin"]),
  validateTransaction("relaunch"),
  controller.relaunchTransaction
);

// 🔐 Log interne (technique). Dépend de Mongo (le controller gère le cas Mongo KO).
router.post("/internal/log", verifyInternalToken, controller.logInternalTransaction);

module.exports = router;
