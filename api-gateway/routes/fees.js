// File: api-gateway/routes/fees.js
"use strict";

/**
 * ⚠️ CETTE PASSERELLE NE CALCULE PLUS RIEN — ELLE RELAIE.
 *
 * Le domaine de la tarification a été déplacé dans Tx-Core le 2026-09-10. Il
 * vivait ici avec huit modèles Mongoose et sa propre base, et Tx-Core — le
 * moteur d'argent — venait y chercher ses devis EN HTTP : la dépendance
 * remontait donc du cœur vers le bord. Une panne de la passerelle arrêtait les
 * virements de l'intérieur du moteur, et la base des barèmes vivait sur la
 * surface la plus exposée d'Internet.
 *
 * Stripe, PayPal et Adyen tiennent la même règle : les dépendances DESCENDENT,
 * et le bord ne possède aucun domaine. Ce qui RESTE ici est exactement ce qui
 * appartient à un bord : authentifier, autoriser, limiter, relayer.
 *
 * ⚠️ LE CONTRÔLE DE RÔLE RESTE ICI, ET C'EST ESSENTIEL. Tx-Core ne revérifie
 * pas de session : il fait confiance au canal interne. Si cette garde
 * disparaissait, les routes de Tx-Core deviendraient accessibles à tout porteur
 * du jeton interne. Verrouillé par `test/security/gatewayIsStateless.test.js`.
 */

const express = require("express");
const router = express.Router();

const config = require("../src/config");
const requireAdmin = require("../src/middlewares/requireAdmin");
const { secureCompare } = require("../src/utils/secureCompare");
const { relayerVers } = require("../src/services/txCoreRelay");

const relais = relayerVers("/api/v1/fees");

/** Simulation : accessible avant la protection admin, comme auparavant. */
router.get("/simulate", relais);

const requireInternalOrAdmin = (req, res, next) => {
  const internalHeader = req.get("x-internal-token");
  const expectedInternal =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  if (internalHeader && expectedInternal && secureCompare(internalHeader, expectedInternal)) {
    return next();
  }

  return requireAdmin(req, res, next);
};

router.use(requireInternalOrAdmin);

router.get("/", relais);
router.get("/:id", relais);
router.post("/", relais);
router.put("/:id", relais);
router.patch("/:id", relais);
router.delete("/:id", relais);

module.exports = router;
