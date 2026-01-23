"use strict";

const router = require("express").Router();
const pricing = require("../controllers/pricingController");
const { authMiddleware } = require("../src/middlewares/auth");

// Quote
router.get("/quote", pricing.quote);
router.post("/quote", pricing.quote);

// Preview (alias)
router.get("/preview", pricing.quote);
router.post("/preview", pricing.quote);

// Lock: DOIT avoir req.user
router.post("/lock", authMiddleware, pricing.lock);

module.exports = router;
