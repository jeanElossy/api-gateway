// File: api-gateway/src/middlewares/auth.js
"use strict";

const jwt = require("jsonwebtoken");
const config = require("../config");
const { getUsersConnection } = require("../db");
const getUserModel = require("../models/userModel");
const logger = require("../logger");

// À implémenter si besoin (redis / db blacklist)
const isTokenBlacklisted = async (_token) => false;

/**
 * ✅ Limite l'auth interne aux routes internes uniquement
 * (évite qu'un INTERNAL_TOKEN permette d'appeler TOUT le gateway)
 */
const INTERNAL_ALLOWED_PREFIXES = [
  "/api/v1/internal",
  "/internal/transactions",
  // si tu as d'autres routes internes:
  // "/api/v1/admin/internal"
];


function isInternalAllowedPath(req) {
  const p = String(req.path || "");
  return INTERNAL_ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || typeof authHeader !== "string") return null;

  const s = authHeader.trim();
  if (!s.toLowerCase().startsWith("bearer ")) return null;

  const token = s.slice(7).trim();
  if (!token || token.toLowerCase() === "null") return null;
  return token;
}

const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Auth interne microservice (gateway -> services)
    // ✅ accepté seulement sur routes internes
    const internalToken = req.headers["x-internal-token"];

    const expectedInternal =
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      config.gatewayInternalToken ||
      config.internalToken ||
      "";

    if (
      internalToken &&
      expectedInternal &&
      String(internalToken) === String(expectedInternal) &&
      isInternalAllowedPath(req)
    ) {
      req.user = { system: true, role: "internal-service" };
      logger?.debug?.("[AUTH] Auth interne acceptée via x-internal-token");
      return next();
    }

    // 2️⃣ Auth JWT utilisateur/admin
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentification requise",
      });
    }

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({
        success: false,
        error: "Token révoqué. Merci de vous reconnecter.",
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, {
        algorithms: ["HS256", "HS512"],
      });
    } catch (err) {
      if (err?.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          error: "Session expirée, reconnectez-vous.",
        });
      }
      if (err?.name === "JsonWebTokenError") {
        return res.status(401).json({
          success: false,
          error: "Token JWT invalide.",
        });
      }
      throw err;
    }

    if (!payload || !payload.id) {
      return res.status(401).json({
        success: false,
        error: "Token invalide (payload incomplet)",
      });
    }

    // Connexion DB utilisateurs
    const usersConn = getUsersConnection();
    const User = getUserModel(usersConn);

    const user = await User.findById(payload.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Utilisateur introuvable",
      });
    }

    req.user = user.toObject ? user.toObject() : user;
    return next();
  } catch (err) {
    logger?.error
      ? logger.error("[AUTH] Erreur middleware:", err)
      : console.error("[AUTH] Erreur middleware:", err);

    return res.status(401).json({
      success: false,
      error: "Accès refusé",
    });
  }
};

// Alias compat
const protect = authMiddleware;

module.exports = { authMiddleware, protect };
