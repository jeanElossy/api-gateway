// // File: src/routes/pricingRoutes.js
// "use strict";

// const router = require("express").Router();
// const pricing = require("../controllers/pricingController");

// // ✅ adapte selon ton middleware réel
// // Si ton fichier exporte { protect } au lieu de { authMiddleware }, remplace ici.
// const { authMiddleware } = require("../src/middlewares/auth");

// // Quote
// router.get("/quote", pricing.quote);
// router.post("/quote", pricing.quote);

// // Preview (alias)
// router.get("/preview", pricing.quote);
// router.post("/preview", pricing.quote);

// // Lock (nécessite utilisateur connecté)
// router.post("/lock", authMiddleware, pricing.lock);

// module.exports = router;



"use strict";

const router = require("express").Router();
const pricing = require("../controllers/pricingController");

/**
 * ✅ Compat authMiddleware / protect
 * selon ton vrai middleware exporté
 */
const authMod = require("../src/middlewares/auth");
const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

// Quote / Preview public
router.get("/quote", pricing.quote);
router.post("/quote", pricing.quote);

router.get("/preview", pricing.quote);
router.post("/preview", pricing.quote);

// Lock protégé
router.post("/lock", authMiddleware, pricing.lock);

module.exports = router;