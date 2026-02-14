"use strict";

const express = require("express");
const router = express.Router();

// ✅ Même middleware interne (x-internal-token)
const validateInternalToken = require("../src/middlewares/validateInternalToken");

// ✅ Controller proxy pur
const {
  proxyLogInternalTransaction,
} = require("../controllers/internalTransactionsProxy.controller");

// (Optionnel) notify legacy, si tu le gardes:
let notifyTransactionEvent = null;
try {
  // eslint-disable-next-line global-require
  notifyTransactionEvent = require("../src/services/transactionNotificationService")
    .notifyTransactionEvent;
} catch {
  notifyTransactionEvent = null;
}

/**
 * POST /internal/transactions/notify (legacy compat)
 */
router.post("/notify", validateInternalToken, async (req, res) => {
  try {
    if (!notifyTransactionEvent) {
      return res.status(200).json({ success: true, ignored: true });
    }
    await notifyTransactionEvent(req.body);
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Erreur interne Gateway" });
  }
});

/**
 * ✅ POST /internal/transactions/log
 * PROXY PUR (0 DB) vers TX-Core
 */
router.post("/log", validateInternalToken, proxyLogInternalTransaction);

module.exports = router;
