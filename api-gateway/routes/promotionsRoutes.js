"use strict";

/** Client promotion preview: pure relay, Tx-Core holds the rules. */

const express = require("express");
const router = express.Router();

const authMod = require("../src/middlewares/auth");
const protect = authMod.protect || authMod.authMiddleware || authMod;

const { relayerVers } = require("../src/services/txCoreRelay");

router.post("/preview", protect, relayerVers("/api/v1/promotions/preview"));

module.exports = router;
