"use strict";

/**
 * Routes de rappel prestataire — surface publique, aucun JWT.
 *
 * L'authentification d'un rappel n'est pas un jeton : c'est sa SIGNATURE, et
 * elle est vérifiée par TX Core, qui détient les secrets. Ce routeur ne fait
 * que du transport (voir l'en-tête de `controllers/providerWebhooksController.js`).
 *
 * ⚠️ `/stripe` et `/bank` ont été RETIRÉS le 2026-09-09 avec leurs rails.
 * Une route de rappel vers un rail qui n'existe plus n'est pas inoffensive :
 * elle accepte un corps, le relaie, et laisse croire à un point d'entrée
 * disponible.
 *
 * ⚠️ ORDRE DE DÉCLARATION. Les deux chemins hérités (`/mobilemoney`,
 * `/visa-direct`) sont déclarés AVANT `/:rail/:provider`. Sans cela, Express
 * ferait correspondre `/mobilemoney` à `/:rail` et le relais chercherait un
 * opérateur nommé… rien.
 */

const express = require("express");
const router = express.Router();

const controller = require("../controllers/providerWebhooksController");

/* Chemins hérités, sans opérateur : conservés, fermés en 410 (voir contrôleur). */
router.post("/mobilemoney", controller.mobilemoneyWebhook);
router.post("/visa-direct", controller.visaDirectWebhook);

/**
 * Chemin canonique. Il reproduit exactement celui que TX Core sert
 * (`/webhooks/providers/:rail/:provider`) : deux chemins identiques des deux
 * côtés du relais, c'est une correspondance qu'on peut vérifier d'un coup d'œil
 * plutôt qu'une traduction à tenir à jour.
 *
 * Exemples :
 *   POST /api/v1/provider-webhooks/mobilemoney/wave
 *   POST /api/v1/provider-webhooks/card/visa_direct
 */
router.post("/:rail/:provider", controller.relayWebhook);

module.exports = router;
