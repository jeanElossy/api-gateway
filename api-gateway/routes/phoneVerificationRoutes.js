"use strict";

/**
 * ============================================================================
 * VÉRIFICATION D'UN NUMÉRO DE DÉPÔT — RELAIS PUR VERS TX CORE
 * ============================================================================
 *
 * ── Ce que ce fichier était, et pourquoi il ne l'est plus ──────────────────
 *
 * Il montait un contrôleur natif de 353 lignes qui lisait `TrustedDepositNumber`
 * dans la base DU BORD et appelait Twilio avec un SECOND jeu d'identifiants.
 * Trois problèmes en un :
 *
 *   1. le bord n'a aucun domaine — il fait du TLS, du routage, de la
 *      vérification de jeton et de la limitation de débit ;
 *   2. la même capacité SMS existait déjà, vivante, dans le backend principal ;
 *   3. **ce routeur n'était monté nulle part.** Aucun `app.use` ne le
 *      référençait, et `/api/v1/phone-verification` était absent de
 *      `PRINCIPAL_PREFIXES`. Les trois appels de l'application mobile
 *      (`tools/api.js`, `GATEWAY_PHONE_VERIFY_*`) rendaient donc **404**.
 *
 * La conséquence n'était pas « une fonctionnalité manquante » : le contrôle de
 * confiance refusait tout dépôt vers un numéro tiers avec un 403 dont le
 * `nextStep` citait ces trois routes inexistantes. L'utilisateur était enfermé,
 * et rien dans les journaux ne distinguait « numéro non vérifié » de « route
 * absente ».
 *
 * ── La répartition retenue le 2026-09-10 ───────────────────────────────────
 *
 *   · TX Core           décide, compte, bloque, conserve la preuve ;
 *   · backend principal envoie et vérifie le SMS (il possède Twilio) ;
 *   · ce fichier        relaie, et rien d'autre.
 *
 * ⚠️ `protect` EST INDISPENSABLE ICI, pas décoratif. Le relais transmet
 * `x-user-id` depuis `req.user._id` : sans authentification préalable, l'en-tête
 * serait absent et TX Core rendrait 401 sur tout — ou pire, si un jour il
 * acceptait un identifiant du corps, n'importe qui vérifierait les numéros d'un
 * autre compte.
 */

const express = require("express");
const router = express.Router();

const authMod = require("../src/middlewares/auth");
const protect = authMod.protect || authMod.authMiddleware || authMod;

const { relayerVers } = require("../src/services/txCoreRelay");

const relais = relayerVers("/api/v1/phone-verification");

router.use(protect);

router.get("/status", relais);
router.post("/start", relais);
router.post("/verify", relais);
router.get("/list", relais);

module.exports = router;
