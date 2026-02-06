// File: api-gateway/routes/publicRoutes.js
"use strict";

const express = require("express");
const router = express.Router();

/**
 * Public read-only endpoints (HMAC signed) mounted at:
 *   app.use("/api/v1/public", publicRoutes)
 *
 * Exposed paths:
 *   GET  /fees/simulate
 *   GET  /exchange-rates/rate
 *   GET|POST /pricing/quote
 *
 * ⚠️ IMPORTANT:
 * - La signature HMAC est déjà vérifiée dans app.js avant ces routes.
 * - Ici: routing read-only uniquement.
 */

// ─────────────────────────────────────────────
// 1) Fees simulate (READ-ONLY)
// ─────────────────────────────────────────────
const feesCtrl = require("../controllers/feesController");
router.get("/fees/simulate", feesCtrl.simulateFee);

// ─────────────────────────────────────────────
// 2) Exchange rate public rate (READ-ONLY)
// ─────────────────────────────────────────────
const exchangeRatesCtrl = require("../controllers/exchangeRatesController");
router.get("/exchange-rates/rate", exchangeRatesCtrl.getRatePublic);

// ─────────────────────────────────────────────
// 3) Pricing quote (READ-ONLY)
// ─────────────────────────────────────────────
const pricingCtrl = require("../controllers/pricingController");

// Quote
router.get("/pricing/quote", pricingCtrl.quote);
router.post("/pricing/quote", pricingCtrl.quote);

// Optional alias
router.get("/pricing/preview", pricingCtrl.quote);
router.post("/pricing/preview", pricingCtrl.quote);

// Safety net: block anything that could be write
router.all("/pricing/lock", (_req, res) =>
  res.status(403).json({ success: false, message: "Forbidden on public endpoint" })
);

module.exports = router;
