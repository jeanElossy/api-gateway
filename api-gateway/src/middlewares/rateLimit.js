"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

/**
 * 🔎 IP client robuste (Render + Cloudflare + proxies)
 * - Priorité: CF-Connecting-IP
 * - Sinon: X-Forwarded-For (première IP)
 * - Sinon: X-Real-IP
 * - Sinon: req.ip (app.set("trust proxy", true) requis)
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

  return String(req.ip || "").trim();
}

function setRetryAfter(res, windowMs) {
  const retryAfterSec = Math.max(1, Math.ceil((windowMs || 60000) / 1000));
  try {
    res.setHeader("Retry-After", String(retryAfterSec));
  } catch {}
  return retryAfterSec;
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

function isNoisyPath(req) {
  const url = req.originalUrl || req.path || "";
  // endpoints appelés au chargement (mobile/admin)
  const noisyPrefixes = [
    "/api/v1/users/me",
    "/api/v1/notifications",
    "/api/v1/balance",
    "/api/v1/rates",
    "/api/v1/badges",
  ];
  return noisyPrefixes.some((p) => url === p || url.startsWith(p + "/"));
}

/**
 * 🔰 1) Bouclier global par IP (protection infra)
 * Objectif: DDoS/loops -> mais NE DOIT PAS casser le "load" mobile/admin.
 * Donc: skip login + skip noisy (users/me, notifications, balance, etc.)
 */
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  skip: (req) => {
    if (req.method === "OPTIONS") return true;
    if (isLoginPath(req)) return true;
    if (isNoisyPath(req)) return true;
    return false;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][global-ip] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
      success: false,
      error: "Trop de requêtes (protection globale). Réessaie dans un instant.",
      retryAfter,
    });
  },
});

/**
 * 🔐 2) Anti brute-force LOGIN (IP + identifiant)
 * - Ne compte pas les succès
 * - Clé: ip + identifiant + path
 */
const authLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12, // ✅ un peu plus permissif
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode < 400,
  keyGenerator: (req) => {
    const ip = getClientIp(req);
    const id = readLoginIdentifier(req) || "unknown";
    const p = req.path || "login";
    return `login:${ip}:${id}:${p}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][login] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      identifier: readLoginIdentifier(req) || null,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de tentatives de connexion. Réessayez dans 10 minutes.",
      retryAfter,
    });
  },
});

/**
 * 👤 3) Limiteur dédié /users/me
 * - Plus permissif (refresh UI)
 * - Clé par user si dispo (après auth), sinon IP
 */
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `me:${uid}` : `meip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][users/me] Limit hit", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de requêtes sur votre profil. Réessaie dans un instant.",
      retryAfter,
    });
  },
});

/**
 * 👤 4) Limiteur global par user (routes protégées)
 * - ne skip plus /users/me (tu as demandé ça)
 * - mais /users/me a déjà son limiter dédié => OK
 */
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || !req.user,
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `user:${uid}` : `ip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][user] Limit hit", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
      success: false,
      error: "Trop de requêtes pour ce compte. Réessaie dans un instant.",
      retryAfter,
    });
  },
});

module.exports = {
  globalIpLimiter,
  authLoginLimiter,
  meLimiter,
  userLimiter,
};
