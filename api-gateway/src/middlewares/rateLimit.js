"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");

/**
 * 🔎 IP client robuste (Render + Cloudflare + proxies)
 * - Priorité: CF-Connecting-IP
 * - Sinon: X-Forwarded-For (première IP)
 * - Sinon: X-Real-IP
 * - Sinon: req.ip (app.set("trust proxy", 1) requis)
 */
function getClientIp(req) {
  const cf =
    req.headers["cf-connecting-ip"] ||
    req.headers["CF-Connecting-IP"] ||
    req.headers["cf-connecting-ip".toUpperCase()];
  if (cf) return String(cf).trim();

  const xff = req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"];
  if (xff) {
    const first = String(xff).split(",")[0]?.trim();
    if (first) return first;
  }

  const xri = req.headers["x-real-ip"] || req.headers["X-Real-IP"];
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

/**
 * ✅ Endpoints “noisy” (polling / refresh UI) :
 * -> on les exclut du bouclier global IP pour éviter les 429,
 * -> et on leur met (si besoin) un limiter dédié plus permissif.
 */
function isNoisyPath(req) {
  const url = req.originalUrl || req.path || "";

  // endpoints appelés au chargement (mobile/admin)
  const noisyPrefixes = [
    "/api/v1/users/me",
    "/api/v1/notifications",
    "/api/v1/balance",
    "/api/v1/rates",
    "/api/v1/badges",

    // ✅ AJOUT: announcements est pollé très souvent (avec _ts)
    "/api/v1/announcements",
  ];

  return noisyPrefixes.some((p) => url === p || url.startsWith(p + "/"));
}

/* ------------------------------------------------------------------ */
/* 1) Bouclier global par IP (protection infra)                         */
/* Objectif: DDoS/loops -> mais NE DOIT PAS casser le "load" mobile.    */
/* Donc: skip login + skip noisy (users/me, notifications, balance, etc)*/
/* ------------------------------------------------------------------ */
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${getClientIp(req)}`,
  skip: (req) => {
    if (req.method === "OPTIONS") return true;
    if (isLoginPath(req)) return true;
    if (isNoisyPath(req)) return true; // ✅ inclut announcements
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

/* ------------------------------------------------------------------ */
/* 2) Anti brute-force LOGIN (IP + identifiant)                         */
/* - Ne compte pas les succès                                           */
/* - Clé: ip + identifiant + path                                       */
/* ------------------------------------------------------------------ */
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
  handler: (req, res) => {
    logger.warn("[RateLimit][login] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      identifier: readLoginIdentifier(req) || null,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, 10 * 60 * 1000);

    return res.status(429).json({
      success: false,
      error: "Trop de tentatives de connexion. Réessayez dans 10 minutes.",
      retryAfter,
    });
  },
});

/* ------------------------------------------------------------------ */
/* 3) Limiteur dédié /users/me                                          */
/* - Plus permissif (refresh UI)                                        */
/* - Clé par user si dispo (après auth), sinon IP                       */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* 4) ✅ Limiteur dédié /announcements                                   */
/* - Route publique (user=null) souvent pollée par l’app                */
/* - Clé IP + platform + locale + audience                              */
/* - Permissif (évite les 429) tout en gardant un garde-fou             */
/* ------------------------------------------------------------------ */
const announcementsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // ✅ 240/min (~4 req/sec) : suffisant même si _ts spam
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const ip = getClientIp(req);
    const q = req.query || {};
    const platform = String(q.platform || "").toLowerCase();
    const locale = String(q.locale || "").toLowerCase();
    const audience = String(q.audience || "").toLowerCase();
    return `ann:${ip}:${platform}:${locale}:${audience}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][announcements] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
      query: req.query || {},
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de requêtes (announcements). Réessaie dans un instant.",
      retryAfter,
    });
  },
});

/* ------------------------------------------------------------------ */
/* 5) Limiteur global par user (routes protégées)                       */
/* - /users/me a déjà son limiter dédié => OK                           */
/* - /announcements est public => pas concerné                           */
/* ------------------------------------------------------------------ */
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
  announcementsLimiter, // ✅ AJOUT
  userLimiter,
};
