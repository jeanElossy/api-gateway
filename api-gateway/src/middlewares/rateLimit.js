// File: api-gateway/src/middlewares/rateLimit.js
"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

/**
 * Récupère une IP client fiable derrière proxy/CDN.
 * Render/Cloudflare passent souvent X-Forwarded-For.
 */
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    // premier IP = client
    return xff.split(",")[0].trim();
  }
  return req.ip;
}

/**
 * Helper: renvoie un 429 JSON propre + Retry-After.
 */
function respond429(res, options, payload) {
  try {
    // windowMs => secondes (arrondi)
    const retryAfterSec = Math.max(
      1,
      Math.ceil((options?.windowMs || 60000) / 1000)
    );
    res.setHeader("Retry-After", String(retryAfterSec));
  } catch (_) {}
  return res.status(options?.statusCode || 429).json(payload);
}

// 🔰 1) Bouclier global par IP (tout le trafic, public + privé)
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requêtes / minute / IP
  standardHeaders: true,
  legacyHeaders: false,

  // IMPORTANT: on utilise IP stable derrière proxy
  keyGenerator: (req) => getClientIp(req),

  // Optionnel: si tu veux limiter surtout les erreurs, pas les succès
  // skipSuccessfulRequests: true,

  handler: (req, res, options) => {
    const ip = getClientIp(req);
    logger.warn("[RateLimit][global-ip] Limite atteinte", {
      ip,
      path: req.originalUrl,
      method: req.method,
    });

    return respond429(res, options, {
      success: false,
      status: 429,
      error: "Trop de requêtes depuis cette adresse IP. Réessaie dans un instant.",
      message: "Trop de requêtes depuis cette adresse IP. Réessaie dans un instant.",
    });
  },
});

// 👤 2) Rate limit par utilisateur authentifié (req.user.*)
const userLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requêtes / minute / utilisateur
  standardHeaders: true,
  legacyHeaders: false,

  // On ne l’applique QUE si l’utilisateur est authentifié
  skip: (req) => !req.user,

  keyGenerator: (req) => {
    if (req.user && (req.user.id || req.user._id)) {
      return `user:${req.user.id || req.user._id}`;
    }
    // fallback sécurité
    return getClientIp(req);
  },

  handler: (req, res, options) => {
    const ip = getClientIp(req);
    logger.warn("[RateLimit][user] Limite atteinte", {
      userId: req.user && (req.user.id || req.user._id),
      ip,
      path: req.originalUrl,
      method: req.method,
    });

    return respond429(res, options, {
      success: false,
      status: 429,
      error: "Trop de requêtes pour ce compte. Réessaie dans un instant.",
      message: "Trop de requêtes pour ce compte. Réessaie dans un instant.",
    });
  },
});

module.exports = {
  globalIpLimiter,
  userLimiter,
};
