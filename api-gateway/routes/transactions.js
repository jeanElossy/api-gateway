// File: routes/transactions.js
"use strict";

/**
 * --------------------------------------------------------------------------
 * Gateway Transactions Routes
 * --------------------------------------------------------------------------
 * Rôle :
 * - exposer les endpoints transactionnels au mobile/web/admin
 * - protéger les routes user avec JWT
 * - autoriser certaines routes techniques internes via x-internal-token
 *
 * IMPORTANT :
 * - /internal/log = route technique interne seulement
 * - toutes les autres routes = JWT requis
 * - les actions admin = JWT + rôle admin/superadmin
 * --------------------------------------------------------------------------
 */

const express = require("express");
const crypto = require("crypto");

const amlMiddleware = require("../src/middlewares/aml");
const validateTransaction = require("../src/middlewares/validateTransaction");
const controller = require("../controllers/transactionsController");
const { requireRole } = require("../src/middlewares/authz");
const { protect } = require("../src/middlewares/auth");

let config = null;
try {
  config = require("../src/config");
} catch {
  config = require("../config");
}

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Récupère la première valeur d'un header si tableau, sinon string.
 */
function firstHeaderValue(v) {
  if (Array.isArray(v)) return String(v[0] || "");
  return String(v || "");
}

/**
 * Compare 2 strings en timing-safe.
 * Retourne false si tailles différentes ou si l'une des deux est vide.
 */
function safeEqualString(aRaw, bRaw) {
  const a = Buffer.from(String(aRaw || "").trim(), "utf8");
  const b = Buffer.from(String(bRaw || "").trim(), "utf8");

  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return false;

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Internal technical auth                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Vérification du token interne pour les appels techniques serveur-à-serveur.
 *
 * Sécurité :
 * - compare constant-time
 * - supporte header string/array
 * - n'accepte pas l'absence de secret côté serveur
 *
 * Usage :
 * - réservé aux appels internes du gateway ou services de confiance
 * - NE REMPLACE PAS un JWT user
 */
function verifyInternalToken(req, res, next) {
  const headerToken = firstHeaderValue(req.headers["x-internal-token"]);

  const expectedToken =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config?.internalToken ||
    "";

  if (!String(expectedToken).trim()) {
    return res.status(401).json({
      success: false,
      error: "Non autorisé (internal token absent côté serveur).",
    });
  }

  const ok = safeEqualString(headerToken, expectedToken);

  if (!ok) {
    return res.status(401).json({
      success: false,
      error: "Non autorisé (internal token invalide).",
    });
  }

  return next();
}

/* -------------------------------------------------------------------------- */
/* Internal technical routes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Route technique interne.
 * Ne doit pas demander de JWT user.
 *
 * Exemple :
 * POST /api/v1/transactions/internal/log
 */
router.post(
  "/internal/log",
  verifyInternalToken,
  controller.logInternalTransaction
);

/* -------------------------------------------------------------------------- */
/* Protected user/admin routes                                                */
/* -------------------------------------------------------------------------- */

/**
 * Tout ce qui suit nécessite un JWT user valide.
 */
router.use(protect);

/**
 * LIST toutes les transactions
 * Proxy vers le TX Core / service cible + normalisation gateway
 */
router.get("/", controller.listTransactions);

/**
 * GET une transaction canonique
 * Le gateway lit d'abord la transaction via le TX Core / PayNoval
 */
router.get("/:id", controller.getTransaction);

/**
 * INITIATE
 * - validation d'entrée
 * - AML middleware
 * - routing flow-aware côté gateway
 */
router.post(
  "/initiate",
  validateTransaction("initiate"),
  amlMiddleware,
  controller.initiateTransaction
);

/**
 * CONFIRM
 * - validation d'entrée
 * - routing flow-aware basé sur transaction canonique si transactionId fourni
 */
router.post(
  "/confirm",
  validateTransaction("confirm"),
  controller.confirmTransaction
);

/**
 * CANCEL
 * - validation d'entrée
 * - routing flow-aware basé sur transaction canonique si transactionId fourni
 */
router.post(
  "/cancel",
  validateTransaction("cancel"),
  controller.cancelTransaction
);

/* -------------------------------------------------------------------------- */
/* Admin routes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * REFUND
 * Réservé admin/superadmin
 */
router.post(
  "/refund",
  requireRole(["admin", "superadmin"]),
  validateTransaction("refund"),
  controller.refundTransaction
);

/**
 * REASSIGN
 * Réservé admin/superadmin
 */
router.post(
  "/reassign",
  requireRole(["admin", "superadmin"]),
  validateTransaction("reassign"),
  controller.reassignTransaction
);

/**
 * VALIDATE
 * Réservé admin/superadmin
 */
router.post(
  "/validate",
  requireRole(["admin", "superadmin"]),
  validateTransaction("validate"),
  controller.validateTransaction
);

/**
 * ARCHIVE
 * Réservé admin/superadmin
 */
router.post(
  "/archive",
  requireRole(["admin", "superadmin"]),
  validateTransaction("archive"),
  controller.archiveTransaction
);

/**
 * RELAUNCH
 * Réservé admin/superadmin
 */
router.post(
  "/relaunch",
  requireRole(["admin", "superadmin"]),
  validateTransaction("relaunch"),
  controller.relaunchTransaction
);

module.exports = router;

