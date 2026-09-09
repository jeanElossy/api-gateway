"use strict";

/**
 * Routes techniques webhook provider
 * - pas de JWT user
 * - signature à valider dans le microservice final ou ici plus tard
 */

const express = require("express");
const router = express.Router();

const controller = require("../controllers/providerWebhooksController");

/**
 * ⚠️ `/stripe` et `/bank` ont été RETIRÉS le 2026-09-09, avec leurs rails.
 *
 * `/stripe` pointait sur `controller.stripeWebhook`, supprimé le même jour :
 * la route aurait fait échouer le montage (`Route.post() requires a callback`).
 * Une route de rappel vers un rail qui n'existe plus n'est pas inoffensive :
 * elle accepte un corps, le relaie, et laisse croire à un point d'entrée
 * disponible.
 */
router.post("/mobilemoney", controller.mobilemoneyWebhook);
router.post("/visa-direct", controller.visaDirectWebhook);

module.exports = router;