"use strict";

/**
 * Gouvernance des plafonds — relais vers Tx-Core (2026-10-17).
 *
 * Back-office uniquement. Le rôle est contrôlé ICI (JWT de l'agent) et
 * RECONTRÔLÉ par Tx-Core, qui relit l'agent en base et impose les quatre yeux
 * (`limitPolicyService`) : la passerelle ne décide de rien.
 */

const express = require("express");
const router = express.Router();

const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");
const { relayerVers } = require("../src/services/txCoreRelay");

const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

const LIMIT_STAFF = ["admin", "superadmin", "compliance"];
const relais = relayerVers("/api/v1/limit-policies");

router.get("/", authMiddleware, requireRole(LIMIT_STAFF), relais);
router.post("/", authMiddleware, requireRole(LIMIT_STAFF), relais);
router.post("/:version/approve", authMiddleware, requireRole(LIMIT_STAFF), relais);
router.post("/:version/reject", authMiddleware, requireRole(LIMIT_STAFF), relais);

module.exports = router;
