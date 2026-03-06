"use strict";

const router = require("express").Router();
const pricing = require("../controllers/pricingController");

const authMod = require("../src/middlewares/auth");
const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

router.get("/quote", pricing.quote);
router.post("/quote", pricing.quote);

router.get("/preview", pricing.quote);
router.post("/preview", pricing.quote);

router.post("/lock", authMiddleware, pricing.lock);

module.exports = router;