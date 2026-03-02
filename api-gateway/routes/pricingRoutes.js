// File: src/routes/pricingRoutes.js
"use strict";

const router = require("express").Router();
const pricing = require("../controllers/pricingController");

// ✅ adapte selon ton middleware réel
// Si ton fichier exporte { protect } au lieu de { authMiddleware }, remplace ici.
const { authMiddleware } = require("../src/middlewares/auth");

// Quote
router.get("/quote", pricing.quote);
router.post("/quote", pricing.quote);

// Preview (alias)
router.get("/preview", pricing.quote);
router.post("/preview", pricing.quote);

// Lock (nécessite utilisateur connecté)
router.post("/lock", authMiddleware, pricing.lock);

module.exports = router;