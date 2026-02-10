// File: api-gateway/src/middlewares/rateLimit.js
"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

/**
 * 🔎 IP client robuste (Render + Cloudflare + proxies)
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

// ✅ Endpoints "bruyants" (chargement app/web)
function isNoisyPath(req) {
  const p = req.path || req.originalUrl || "";

  // exact + prefixes
  const noisyPrefixes = [
    "/api/v1/users/me",
    "/api/v1/notifications",
    "/api/v1/balance",
    "/api/v1/users/me/badges",
    "/api/v1/vaults/me",
    "/api/v1/vaults/withdrawals/me",
  ];

  return noisyPrefixes.some((x) => p === x || p.startsWith(x + "/"));
}

// 🔰 1) Bouclier global par IP (edge)
// ✅ Ici on SKIP login + OPTIONS + endpoints bruyants
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || isLoginPath(req) || isNoisyPath(req),
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
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
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

// ✅ 3) Limiteur dédié à /users/me (plus permissif)
// - Monté après auth => req.user dispo
// - Limite par user (fallback IP si besoin)
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 900, // ✅ permissif (dashboard/app peut rafaler)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `me:${uid}` : `meip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][users-me] Limite atteinte", {
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
      error: "Trop de requêtes sur /users/me. Réessaie dans un instant.",
    });
  },
});

// 👤 4) Rate limit global par utilisateur authentifié
// ✅ IMPORTANT: ne plus skip /users/me ici (on veut limiter PAR USER, pas par IP)
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
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
  meLimiter,
  userLimiter,
};
