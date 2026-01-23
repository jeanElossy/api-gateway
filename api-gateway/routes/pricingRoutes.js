"use strict";

const router = require("express").Router();
const pricing = require("../controllers/pricingController");
const { authMiddleware } = require("../src/middlewares/auth");

// Preview (public si tu veux) — mais tu n’as pas mis /api/v1/pricing/quote dans openEndpoints.
// Donc ça passera par authMiddleware global, sauf si tu l’ajoutes dans openEndpoints.
router.get("/quote", pricing.quote);
router.post("/quote", pricing.quote);

// Lock: DOIT avoir req.user
router.post("/lock", authMiddleware, pricing.lock);

module.exports = router;
