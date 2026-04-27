// File: routes/adminComplianceRoutes.js
"use strict";

const express = require("express");

function reqAny(paths, fallback = null) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(p);
    } catch {}
  }
  return fallback;
}

const authModule =
  reqAny(["../src/middlewares/auth", "../middlewares/auth"], {}) || {};

const authzModule =
  reqAny(["../src/middlewares/authz", "../middlewares/authz"], {}) || {};

const protect = authModule.protect || authModule.default || authModule;
const requireRole = authzModule.requireRole || authzModule.default;

const {
  listComplianceTransactions,
} = require("../controllers/adminCompliance.controller");

const router = express.Router();

if (typeof protect !== "function") {
  throw new Error("[adminComplianceRoutes] Middleware protect introuvable.");
}

if (typeof requireRole !== "function") {
  throw new Error("[adminComplianceRoutes] Middleware requireRole introuvable.");
}

router.use(protect);

/**
 * GET /api/v1/admin/compliance/transactions
 *
 * Réservé admin/superadmin.
 * Retourne les transactions/cas détectés par :
 * - COMPLIANCE_REVIEW_REQUIRED
 * - SANCTIONS_SCREENING_BLOCKED
 * - PEP_SANCTIONED
 * - BLACKLISTED
 * - RISKY_COUNTRY
 * - AML_*
 */
router.get(
  "/transactions",
  requireRole(["admin", "superadmin"]),
  listComplianceTransactions
);

module.exports = router;