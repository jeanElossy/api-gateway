"use strict";

const express = require("express");
const router = express.Router();

const {
  listPricingRules,
  getPricingRuleById,
  listPricingRuleVersions,
} = require("../controllers/pricingRulesController");

const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");

/** Compat protect / authMiddleware. */
const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

const STAFF = ["admin", "superadmin"];

/**
 * ⚠️ LECTURE SEULE — VOLONTAIREMENT.
 *
 * POST, PUT, PATCH et DELETE ont été retirés : toute évolution tarifaire passe
 * désormais par /api/v1/pricing-change-requests, qui impose un second valideur
 * et écrit une version immuable. Tant que ces routes existaient, la gouvernance
 * se contournait en un appel.
 *
 * Effet secondaire heureux : le PATCH destructeur disparaît. `pickPayload`
 * reconstruisait l'objet complet avec ses valeurs par défaut, si bien qu'un
 * PATCH {active:false} réécrivait fee.mode à NONE et fx.mode à PASS_THROUGH.
 *
 * Ne pas les rétablir « temporairement ».
 */
router.get("/", authMiddleware, requireRole(STAFF), listPricingRules);
router.get("/:id", authMiddleware, requireRole(STAFF), getPricingRuleById);
router.get("/:id/versions", authMiddleware, requireRole(STAFF), listPricingRuleVersions);

module.exports = router;
