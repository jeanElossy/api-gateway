// // File: api-gateway/routes/transactions.js
// 'use strict';

// const express = require('express');
// const amlMiddleware = require('../src/middlewares/aml');
// const validateTransaction = require('../src/middlewares/validateTransaction');
// const controller = require('../controllers/transactionsController');
// const { requireRole } = require('../src/middlewares/authz');
// const config = require('../src/config');

// const router = express.Router();

// /**
//  * Vérification du token interne pour les appels techniques
//  */
// function verifyInternalToken(req, res, next) {
//   const headerToken = req.headers['x-internal-token'] || '';
//   const expectedToken = config.internalToken || process.env.GATEWAY_INTERNAL_TOKEN || '';

//   if (!expectedToken || headerToken !== expectedToken) {
//     return res.status(401).json({
//       success: false,
//       error: 'Non autorisé (internal token invalide).',
//     });
//   }
//   return next();
// }

// // GET une transaction
// router.get('/:id', controller.getTransaction);

// // LIST toutes les transactions
// router.get('/', controller.listTransactions);

// // INITIATE : Validation + AML + proxy
// router.post(
//   '/initiate',
//   validateTransaction('initiate'),
//   amlMiddleware,
//   controller.initiateTransaction
// );

// // CONFIRM
// router.post(
//   '/confirm',
//   validateTransaction('confirm'),
//   controller.confirmTransaction
// );

// // CANCEL
// router.post(
//   '/cancel',
//   validateTransaction('cancel'),
//   controller.cancelTransaction
// );

// // REFUND : réservé admin/superadmin
// router.post(
//   '/refund',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('refund'),
//   controller.refundTransaction
// );

// // REASSIGN : réservé admin/superadmin
// router.post(
//   '/reassign',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('reassign'),
//   controller.reassignTransaction
// );

// // VALIDATE : réservé admin/superadmin
// router.post(
//   '/validate',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('validate'),
//   controller.validateTransaction
// );

// // ARCHIVE : réservé admin/superadmin
// router.post(
//   '/archive',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('archive'),
//   controller.archiveTransaction
// );

// // RELAUNCH : réservé admin/superadmin
// router.post(
//   '/relaunch',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('relaunch'),
//   controller.relaunchTransaction
// );

// // 🔐 Log interne (cagnotte participation, etc.)
// router.post(
//   '/internal/log',
//   verifyInternalToken,
//   controller.logInternalTransaction
// );

// module.exports = router;




// File: api-gateway/routes/transactions.js
'use strict';

const express = require('express');
const amlMiddleware = require('../src/middlewares/aml');
const validateTransaction = require('../src/middlewares/validateTransaction');
const controller = require('../controllers/transactionsController');
const { requireRole } = require('../src/middlewares/authz');
const config = require('../src/config');

const router = express.Router();

/**
 * Vérification du token interne pour les appels techniques
 */
function verifyInternalToken(req, res, next) {
  const headerToken = req.headers['x-internal-token'] || '';
  const expectedToken = config.internalToken || process.env.GATEWAY_INTERNAL_TOKEN || '';

  if (!expectedToken || headerToken !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: 'Non autorisé (internal token invalide).',
    });
  }
  return next();
}

// GET une transaction
router.get('/:id', controller.getTransaction);

// LIST toutes les transactions
router.get('/', controller.listTransactions);

// INITIATE : Validation + AML + proxy
router.post(
  '/initiate',
  validateTransaction('initiate'),
  amlMiddleware,
  controller.initiateTransaction
);

// CONFIRM
router.post(
  '/confirm',
  validateTransaction('confirm'),
  controller.confirmTransaction
);

// CANCEL
router.post(
  '/cancel',
  validateTransaction('cancel'),
  controller.cancelTransaction
);

// REFUND : réservé admin/superadmin
router.post(
  '/refund',
  requireRole(['admin', 'superadmin']),
  validateTransaction('refund'),
  controller.refundTransaction
);

// REASSIGN : réservé admin/superadmin
router.post(
  '/reassign',
  requireRole(['admin', 'superadmin']),
  validateTransaction('reassign'),
  controller.reassignTransaction
);

// VALIDATE : réservé admin/superadmin
router.post(
  '/validate',
  requireRole(['admin', 'superadmin']),
  validateTransaction('validate'),
  controller.validateTransaction
);

// ARCHIVE : réservé admin/superadmin
router.post(
  '/archive',
  requireRole(['admin', 'superadmin']),
  validateTransaction('archive'),
  controller.archiveTransaction
);

// RELAUNCH : réservé admin/superadmin
router.post(
  '/relaunch',
  requireRole(['admin', 'superadmin']),
  validateTransaction('relaunch'),
  controller.relaunchTransaction
);

// 🔐 Log interne (cagnotte participation, etc.)
router.post(
  '/internal/log',
  verifyInternalToken,
  controller.logInternalTransaction
);

module.exports = router;
