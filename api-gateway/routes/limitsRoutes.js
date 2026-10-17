"use strict";

/**
 * Plafonds du client — relais pur vers Tx-Core (2026-10-17).
 *
 * `GET /api/v1/limits?currency=XOF` : plafonds par opération, ce qui a été
 * utilisé sur 24 h et 30 jours, ce qui reste et quand ça se libère. Tx-Core
 * calcule (`services/limits/`) ; la passerelle authentifie et relaie, elle ne
 * détient aucun chiffre.
 */

const express = require("express");
const router = express.Router();

const authMod = require("../src/middlewares/auth");
const protect = authMod.protect || authMod.authMiddleware || authMod;

const { relayerVers } = require("../src/services/txCoreRelay");

router.get("/", protect, relayerVers("/api/v1/limits"));

module.exports = router;
