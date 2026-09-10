"use strict";

/**
 * ⚠️ CETTE PASSERELLE NE CALCULE PLUS RIEN — ELLE RELAIE.
 *
 * Le domaine de la tarification a été déplacé dans Tx-Core le 2026-09-10 : il
 * vivait ici avec sa propre base, et Tx-Core venait y chercher ses devis en
 * HTTP — la dépendance remontait du moteur d'argent vers le bord. Stripe,
 * PayPal et Adyen tiennent la règle inverse : les dépendances DESCENDENT, et le
 * bord ne possède aucun domaine.
 *
 * ⚠️ LE CONTRÔLE DE RÔLE RESTE ICI, ET C'EST ESSENTIEL. Tx-Core ne revérifie
 * pas de session : il fait confiance au canal interne. Si cette garde
 * disparaissait, ses routes deviendraient accessibles à tout porteur du jeton
 * interne. Verrouillé par `test/security/gatewayIsStateless.test.js`.
 */

const express = require("express");
const router = express.Router();

const requireAdmin = require("../../src/middlewares/requireAdmin");
const { relayerVers } = require("../../src/services/txCoreRelay");

const relais = relayerVers("/api/v1/exchange-rates");

/** Taux public, SANS auth : c'est celui que le mobile lit avant connexion. */
router.get("/rate", relais);

/** Tout le reste est réservé à l'administration. */
router.use(requireAdmin);

router.get("/", relais);
router.post("/", relais);
router.put("/:id", relais);
router.delete("/:id", relais);

module.exports = router;
