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

const isMePath = (req) =>
  req.path === "/api/v1/users/me" ||
  req.originalUrl?.startsWith("/api/v1/users/me");

const readLoginIdentifier = (req) => {
  const raw =
    req.body?.emailOrPhone ||
    req.body?.email ||
    req.body?.phone ||
    req.body?.username ||
    "";
  return String(raw || "").trim().toLowerCase();
};

const setRetryAfter = (res, windowMs) => {
  const retryAfterSec = Math.ceil((windowMs || 60000) / 1000);
  try {
    res.setHeader("Retry-After", String(retryAfterSec));
  } catch {}
};

/**
 * 🔰 1) Bouclier global par IP
 * But: protéger l’infra (DDoS, loops),
 * MAIS on skip les routes très “bruyantes” et on laisse userLimiter faire le boulot.
 */
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1200, // plus large pour éviter de casser mobile/admin (le userLimiter fera le vrai contrôle)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
  skip: (req) => {
    if (req.method === "OPTIONS") return true;
    if (isLoginPath(req)) return true; // login géré par authLoginLimiter
    if (isMePath(req)) return true; // /users/me géré par meLimiter + userLimiter
    // routes souvent appelées au load
    const noisy = [
      "/api/v1/notifications",
      "/api/v1/balance",
      "/api/v1/rates",
    ];
    if (noisy.some((p) => req.originalUrl?.startsWith(p))) return true;
    return false;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][global-ip] Limite atteinte", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });
    setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
      success: false,
      error: "Trop de requêtes depuis cette adresse IP. Réessaie dans un instant.",
    });
  },
});

/**
 * 🔐 2) Anti brute-force LOGIN (IP + identifiant)
 * ✅ skipSuccessfulRequests => si login OK, ça ne compte pas.
 */
const authLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8, // 8 tentatives / 10 min / (ip + identifiant)
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
    logger.warn("[RateLimit][login] Limite atteinte", {
      ip: getClientIp(req),
      path: req.originalUrl,
      identifier: readLoginIdentifier(req) || null,
      method: req.method,
    });
    setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de tentatives de connexion. Réessayez dans 10 minutes.",
    });
  },
});

/**
 * 👤 3) Limiteur spécial /users/me
 * Objectif: autoriser les refresh UI sans punir l’utilisateur.
 * -> on limite par user si possible, sinon par IP.
 */
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120/min (safe pour admin + mobile)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `me:${uid}` : `meip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][users/me] Limite atteinte", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });
    setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de requêtes sur votre profil. Réessaie dans un instant.",
    });
  },
});

/**
 * 👤 4) Rate limit par utilisateur authentifié (toutes les routes protégées)
 * Objectif: limiter proprement le spam sans casser le load.
 */
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // 300/min par user (admin panels font beaucoup d'appels)
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
    setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
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
