"use strict";

const express = require("express");
const router = express.Router();

const exchangeRatesCtrl = require("../controllers/exchangeRatesController");

// adapte selon ton vrai export auth
const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");

const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

/* =========================================================
 * Public live market
 * ========================================================= */
router.get("/rate", exchangeRatesCtrl.getRatePublic);
router.get("/supported-currencies", exchangeRatesCtrl.getSupportedCurrenciesPublic);

/* =========================================================
 * Admin custom rates
 * ========================================================= */
router.get("/", authMiddleware, requireRole(["admin", "superadmin"]), exchangeRatesCtrl.list);
router.post("/", authMiddleware, requireRole(["admin", "superadmin"]), exchangeRatesCtrl.create);
router.put("/:id", authMiddleware, requireRole(["admin", "superadmin"]), exchangeRatesCtrl.update);
router.delete("/:id", authMiddleware, requireRole(["admin", "superadmin"]), exchangeRatesCtrl.remove);

module.exports = router;