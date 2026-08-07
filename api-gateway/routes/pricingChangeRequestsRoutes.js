"use strict";

const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/pricingChangeRequestsController");

const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");

/** Compat protect / authMiddleware, comme dans pricingRulesRoutes.js. */
const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

const STAFF = ["admin", "superadmin"];

/**
 * Le support n'a aucun accès, comme pour les ajustements de solde : modifier un
 * prix touche toutes les transactions des corridors concernés.
 */
router.get("/", authMiddleware, requireRole(STAFF), ctrl.list);
router.post("/", authMiddleware, requireRole(STAFF), ctrl.create);

router.get("/:id", authMiddleware, requireRole(STAFF), ctrl.getById);
router.get("/:id/preview", authMiddleware, requireRole(STAFF), ctrl.preview);

router.post("/:id/approve", authMiddleware, requireRole(STAFF), ctrl.approve);
router.post("/:id/reject", authMiddleware, requireRole(STAFF), ctrl.reject);
router.post("/:id/cancel", authMiddleware, requireRole(STAFF), ctrl.cancel);

// Réparation du mode dégradé : superadmin uniquement.
router.post(
  "/:id/retry-apply",
  authMiddleware,
  requireRole(["superadmin"]),
  ctrl.retryApply
);

module.exports = router;
