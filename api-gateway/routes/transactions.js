// const express = require('express');
// const amlMiddleware = require('../src/middlewares/aml');
// const validateTransaction = require('../src/middlewares/validateTransaction');
// const controller = require('../controllers/transactionsController');
// const { requireRole } = require('../src/middlewares/authz');

// const router = express.Router();

// // GET une transaction
// router.get('/:id', controller.getTransaction);

// // LIST toutes les transactions
// router.get('/', controller.listTransactions);

// // INITIATE : Validation + AML + proxy
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

// // REFUND : réservé admin/superadmin (rôle passé via req.user.role)
// router.post(
//   '/refund',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('refund'),
//   controller.refundTransaction
// );

// // REASSIGN : réservé admin/superadmin (rôle passé via req.user.role)
// router.post(
//   '/reassign',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('reassign'),
//   controller.reassignTransaction
// );



// router.post(
//   '/validate',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('validate'),
//   controller.validateTransaction // (à ajouter dans ton controller Gateway)
// );


// router.post(
//   '/archive',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('archive'), // à adapter, voir plus bas
//   controller.archiveTransaction
// );

// router.post(
//   '/relaunch',
//   requireRole(['admin', 'superadmin']),
//   validateTransaction('relaunch'), // à adapter, voir plus bas
//   controller.relaunchTransaction
// );


// module.exports = router;



// routes/transactions.js (ou équivalent)

const express = require('express');
const amlMiddleware = require('../src/middlewares/aml');
const validateTransaction = require('../src/middlewares/validateTransaction');
const controller = require('../controllers/transactionsController');
const { requireRole } = require('../src/middlewares/authz');

const router = express.Router();

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

// REFUND : réservé admin/superadmin (rôle passé via req.user.role)
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

module.exports = router;
