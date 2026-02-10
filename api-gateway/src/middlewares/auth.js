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
  // ajoute ici tes autres routes internes si besoin
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

/** ✅ Rend le gateway compatible avec le token du principal */
function resolveUserIdFromPayload(p) {
  return (
    p?.id ||
    p?._id ||
    p?.sub ||
    p?.user?.id ||
    p?.user?._id ||
    p?.userId ||
    null
  );
}

/** ✅ Unifie la clé JWT (priorité env, fallback config) */
function getJwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.PRINCIPAL_JWT_SECRET || // si tu utilises ce nom quelque part
    config.jwtSecret ||
    ""
  );
}

const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Auth interne microservice (gateway -> services)
    // ✅ accepté seulement sur routes internes
    const internalToken =
      req.headers["x-internal-token"] ||
      req.headers["x_internal_token"] ||
      req.headers["x-internal"] ||
      null;

    const expectedInternal =
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      config.gatewayInternalToken ||
      config.internalToken ||
      "";

    if (
      internalToken &&
      expectedInternal &&
      String(internalToken).trim() === String(expectedInternal).trim() &&
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

    const secret = getJwtSecret();
    if (!secret) {
      logger?.error?.("[AUTH] JWT secret missing (JWT_SECRET/config.jwtSecret)");
      return res.status(500).json({
        success: false,
        error: "Configuration JWT manquante (gateway)",
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret, {
        algorithms: ["HS256", "HS512"], // garde si tu utilises HS512, sinon mets juste ["HS256"]
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

    const userId = resolveUserIdFromPayload(payload);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Token invalide (id/sub manquant)",
      });
    }

    // Connexion DB utilisateurs
    const usersConn = getUsersConnection();
    const User = getUserModel(usersConn);

    const user = await User.findById(userId);
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
