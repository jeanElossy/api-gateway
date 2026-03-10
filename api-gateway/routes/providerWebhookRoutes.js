"use strict";

/**
 * Routes techniques webhook provider
 * - pas de JWT user
 * - signature à valider dans le microservice final ou ici plus tard
 */

const express = require("express");
const router = express.Router();

const controller = require("../controllers/providerWebhooksController");

router.post("/mobilemoney", controller.mobilemoneyWebhook);
router.post("/bank", controller.bankWebhook);
router.post("/stripe", controller.stripeWebhook);
router.post("/visa-direct", controller.visaDirectWebhook);

module.exports = router;