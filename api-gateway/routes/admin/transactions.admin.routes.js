const express = require("express");
const { requireRole } = require("../../src/middlewares/authz");
const adminTxCtrl = require("../../controllers/adminTransactionsController");
const { protect } = require("../../src/middlewares/auth");

const router = express.Router();

/**
 * Toutes les routes admin transactions :
 * - JWT obligatoire
 * - rôle admin/superadmin obligatoire
 */
router.use(protect, requireRole(["admin", "superadmin"]));

/**
 * EXPORT CSV
 * IMPORTANT:
 * cette route doit être déclarée AVANT "/:id"
 * sinon Express peut interpréter "export" comme un id.
 */
router.get("/export/csv", adminTxCtrl.exportTransactionsCsv);

/**
 * LIST
 * GET /api/v1/admin/transactions
 */
router.get("/", adminTxCtrl.listTransactions);

/**
 * ONE
 * GET /api/v1/admin/transactions/:id
 */
router.get("/:id", adminTxCtrl.getTransactionById);

/**
 * VALIDATE
 * POST /api/v1/admin/transactions/:id/validate
 */
router.post("/:id/validate", adminTxCtrl.validateTransaction);

/**
 * CANCEL
 * POST /api/v1/admin/transactions/:id/cancel
 */
router.post("/:id/cancel", adminTxCtrl.cancelTransaction);

/**
 * REFUND
 * POST /api/v1/admin/transactions/:id/refund
 */
router.post("/:id/refund", adminTxCtrl.refundTransaction);

/**
 * REASSIGN
 * POST /api/v1/admin/transactions/:id/reassign
 */
router.post("/:id/reassign", adminTxCtrl.reassignTransaction);

/**
 * RELAUNCH
 * POST /api/v1/admin/transactions/:id/relaunch
 */
router.post("/:id/relaunch", adminTxCtrl.relaunchTransaction);

/**
 * ARCHIVE
 * POST /api/v1/admin/transactions/:id/archive
 */
router.post("/:id/archive", adminTxCtrl.archiveTransaction);

/**
 * UPDATE
 * PUT /api/v1/admin/transactions/:id
 */
router.put("/:id", adminTxCtrl.updateTransaction);

/**
 * SOFT DELETE
 * DELETE /api/v1/admin/transactions/:id
 */
router.delete("/:id", adminTxCtrl.softDeleteTransaction);

module.exports = router;