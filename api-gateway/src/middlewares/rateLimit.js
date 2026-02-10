// File: api-gateway/src/middlewares/rateLimit.js
"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

/**
 * 🔎 IP client robuste (Render + Cloudflare + proxies)
 * - Priorité: CF-Connecting-IP (quand Cloudflare est devant)
 * - Sinon: X-Forwarded-For (première IP)
 * - Sinon: X-Real-IP
 * - Fallback: req.ip
 */
function getClientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = String(xff).split(",")[0]?.trim();
    if (first) return first;
  }

  const xri = req.headers["x-real-ip"];
  if (xri) return String(xri).trim();

  return req.ip;
}

const isLoginPath = (req) =>
  req.path === "/api/v1/auth/login" ||
  req.path === "/api/v1/auth/login-2fa" ||
  req.originalUrl?.startsWith("/api/v1/auth/login") ||
  req.originalUrl?.startsWith("/api/v1/auth/login-2fa");

const readLoginIdentifier = (req) => {
  const raw =
    req.body?.emailOrPhone ||
    req.body?.email ||
    req.body?.phone ||
    req.body?.username ||
    "";
  return String(raw || "").trim().toLowerCase();
};

// 🔰 1) Bouclier global par IP
// ✅ IMPORTANT: on limite par IP client réelle, pas req.ip brute.
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // ✅ un peu plus large (mobile burst + admin)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || isLoginPath(req), // login géré par authLoginLimiter
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][global-ip] Limite atteinte", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfterSec = Math.ceil((options.windowMs || 60000) / 1000);
    try {
      res.setHeader("Retry-After", String(retryAfterSec));
    } catch {}

    return res.status(options.statusCode).json({
      success: false,
      error: "Trop de requêtes depuis cette adresse IP. Réessaie dans un instant.",
    });
  },
});

// 🔐 2) Anti brute-force LOGIN (IP + identifiant)
const authLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8, // 8 tentatives / 10 min / (ip + identifiant)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  // ✅ si login OK (<400), ne compte pas
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode < 400,

  keyGenerator: (req) => {
    const ip = getClientIp(req);
    const id = readLoginIdentifier(req) || "unknown";
    return `login:${ip}:${id}`;
  },

  handler: (req, res, _next, options) => {
    const retryAfterSec = Math.ceil((options.windowMs || 600000) / 1000);
    try {
      res.setHeader("Retry-After", String(retryAfterSec));
    } catch {}

    logger.warn("[RateLimit][login] Limite atteinte", {
      ip: getClientIp(req),
      path: req.originalUrl,
      identifier: readLoginIdentifier(req) || null,
      method: req.method,
    });

    return res.status(429).json({
      success: false,
      error: "Trop de tentatives de connexion. Réessayez dans 10 minutes.",
    });
  },
});

// 👤 3) Rate limit par utilisateur authentifié
const userLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 240, // ✅ mobile fait plusieurs appels au chargement
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || !req.user,
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `user:${uid}` : `ip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][user] Limite atteinte", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfterSec = Math.ceil((options.windowMs || 60000) / 1000);
    try {
      res.setHeader("Retry-After", String(retryAfterSec));
    } catch {}

    return res.status(options.statusCode).json({
      success: false,
      error: "Trop de requêtes pour ce compte. Réessaie dans un instant.",
    });
  },
});

module.exports = {
  globalIpLimiter,
  authLoginLimiter,
  userLimiter,
};
