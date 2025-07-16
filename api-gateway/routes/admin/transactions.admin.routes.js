const express = require('express');
const { requireRole } = require('../../src/middlewares/authz');      
const adminTxCtrl = require('../../controllers/adminTransactionsController');
const { protect } = require('../../src/middlewares/auth');
router.use(protect);


const router = express.Router();

// Toutes les routes requièrent un admin/superadmin authentifié
router.use(protect, requireRole(['admin', 'superadmin']));

// LIST (avec search/filtres/pagination)
router.get('/', adminTxCtrl.listTransactions);

// ONE
router.get('/:id', adminTxCtrl.getTransactionById);

// VALIDATE
router.post('/:id/validate', adminTxCtrl.validateTransaction);

// CANCEL
router.post('/:id/cancel', adminTxCtrl.cancelTransaction);

// REFUND
router.post('/:id/refund', adminTxCtrl.refundTransaction);

// REASSIGN
router.post('/:id/reassign', adminTxCtrl.reassignTransaction);

// RELAUNCH
router.post('/:id/relaunch', adminTxCtrl.relaunchTransaction);

// ARCHIVE
router.post('/:id/archive', adminTxCtrl.archiveTransaction);

// UPDATE (assignation, note, ... : custom fields)
router.put('/:id', adminTxCtrl.updateTransaction);

// SOFT DELETE (AML flag/archived)
router.delete('/:id', adminTxCtrl.softDeleteTransaction);

// EXPORT CSV
router.get('/export/csv', adminTxCtrl.exportTransactionsCsv);

module.exports = router;
