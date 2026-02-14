"use strict";

const express = require("express");
const router = express.Router();

const validateInternalToken = require("../src/middlewares/validateInternalToken");

const {
  proxyLogInternalTransaction,
} = require("../controllers/internalTransactionsProxy.controller");

// (Optionnel) notify versionné si tu le gardes:
let notifyTransactionEvent = null;
try {
  // eslint-disable-next-line global-require
  notifyTransactionEvent = require("../src/services/transactionNotificationService")
    .notifyTransactionEvent;
} catch {
  notifyTransactionEvent = null;
}

/**
 * POST /api/v1/internal/transactions/notify
 */
router.post("/transactions/notify", validateInternalToken, async (req, res) => {
  try {
    if (!notifyTransactionEvent) {
      return res.status(200).json({ success: true, ignored: true });
    }
    await notifyTransactionEvent(req.body);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Erreur lors du traitement de la notification transaction.",
    });
  }
});

/**
 * ✅ POST /api/v1/internal/transactions/log
 * PROXY PUR (0 DB) vers TX-Core
 */
router.post("/transactions/log", validateInternalToken, proxyLogInternalTransaction);

module.exports = router;
