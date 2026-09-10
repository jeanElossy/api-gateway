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

/**
 * ⚠️ LE CONTRÔLEUR NATIF A DISPARU, ET C'EST LE CORRECTIF.
 *
 * `controllers/adminCompliance.controller.js` (405 l.) appelait
 * `/api/v1/internal/admin/compliance/transactions` — une route qui n'existait
 * PAS dans Tx-Core — récoltait un 404, et se repliait en silence sur les 500
 * dernières transactions qu'il filtrait en mémoire par fouille de JSON.
 *
 * Un blocage de sanctions survenu 600 transactions plus tôt était donc
 * invisible au responsable conformité, sans que rien ne le dise. La route
 * existe désormais dans Tx-Core, qui lit son propre journal `AMLLog` avec
 * l'index prévu pour ça et ANNONCE la fenêtre couverte.
 *
 * Un relais ne réinterprète pas ce qu'il transporte : le filtrage, la
 * pagination et les statistiques se calculent chez le propriétaire de la
 * donnée.
 */
const { relayerVers } = require("../src/services/txCoreRelay");

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
  relayerVers("/api/v1/internal/admin/compliance")
);

module.exports = router;