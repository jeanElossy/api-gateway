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

const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");
const { relayerVers } = require("../src/services/txCoreRelay");

const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

const STAFF = ["admin", "superadmin"];
const relais = relayerVers("/api/v1/pricing-change-requests");

router.get("/", authMiddleware, requireRole(STAFF), relais);
router.post("/", authMiddleware, requireRole(STAFF), relais);

router.get("/:id", authMiddleware, requireRole(STAFF), relais);
router.get("/:id/preview", authMiddleware, requireRole(STAFF), relais);

router.post("/:id/approve", authMiddleware, requireRole(STAFF), relais);
router.post("/:id/reject", authMiddleware, requireRole(STAFF), relais);
router.post("/:id/cancel", authMiddleware, requireRole(STAFF), relais);

/** Réparation du mode dégradé : superadmin uniquement. */
router.post(
  "/:id/retry-apply",
  authMiddleware,
  requireRole(["superadmin"]),
  relais
);

module.exports = router;
