"use strict";

const rateLimit = require("./rateLimiter");
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
 * ✅ Endpoints “noisy” (polling / refresh UI)
 * -> on les exclut du bouclier global IP pour éviter les 429
 * -> et on leur met si besoin un limiter dédié plus permissif
 */
function isNoisyPath(req) {
  const url = req.originalUrl || req.path || "";

  const noisyPrefixes = [
    "/api/v1/users/me",
    "/api/v1/notifications",
    "/api/v1/balance",
    "/api/v1/rates",
    "/api/v1/badges",
    "/api/v1/announcements",

    // ✅ back office transactions
    "/api/v1/admin/transactions",
  ];

  return noisyPrefixes.some((p) => url === p || url.startsWith(p + "/"));
}

/* ------------------------------------------------------------------ */
/* 1) Bouclier global par IP                                          */
/* ------------------------------------------------------------------ */
const globalIpLimiter = rateLimit({
  name: "gw-global-ip",
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${getClientIp(req)}`,
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

/* ------------------------------------------------------------------ */
/* 2) Anti brute-force LOGIN                                          */
/* ------------------------------------------------------------------ */
const authLoginLimiter = rateLimit({
  name: "gw-auth-login",
  windowMs: 10 * 60 * 1000,
  max: 12,
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
/* 3) Limiteur dédié /users/me                                        */
/* ------------------------------------------------------------------ */
const meLimiter = rateLimit({
  name: "gw-users-me",
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
/* 4) Limiteur dédié /announcements                                   */
/* ------------------------------------------------------------------ */
const announcementsLimiter = rateLimit({
  name: "gw-announcements",
  windowMs: 60 * 1000,
  max: 240,
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
/* 5) Limiteur dédié admin transactions                               */
/* ------------------------------------------------------------------ */
const adminTransactionsLimiter = rateLimit({
  name: "gw-admin-transactions",
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `admin-tx:${uid}` : `admin-tx-ip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][admin-transactions] Limit hit", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error: "Trop de requêtes sur les transactions admin. Réessaie dans un instant.",
      retryAfter,
    });
  },
});

/* ------------------------------------------------------------------ */
/* 5 bis) Ajustements manuels de solde                                */
/* ------------------------------------------------------------------ */

/**
 * Limiteur dédié aux ajustements manuels de solde
 * (`/api/v1/admin/adjustments`).
 *
 * Volontairement beaucoup plus strict que `adminTransactionsLimiter` : lister
 * des transactions est une lecture banale, alors que chaque appel ici crée ou
 * valide un mouvement d'argent décidé par un humain. Un rythme élevé sur cette
 * route n'a aucun usage légitime — c'est soit un script, soit un compte
 * compromis. 20 appels par minute laissent largement de quoi travailler à la
 * main tout en rendant l'abattage en masse impossible.
 *
 * La clé est l'identifiant de l'administrateur, pas l'IP : plusieurs
 * administrateurs derrière un même réseau d'entreprise ne doivent pas se
 * bloquer mutuellement, et changer d'IP ne doit pas remettre le compteur à
 * zéro.
 */
const adminAdjustmentsLimiter = rateLimit({
  name: "gw-admin-adjustments",
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => {
    const uid = req.user?.id || req.user?._id;
    return uid ? `admin-adj:${uid}` : `admin-adj-ip:${getClientIp(req)}`;
  },
  handler: (req, res, _next, options) => {
    // Journalisé en `warn` : sur cette route, atteindre la limite est un
    // signal de sécurité à part entière, pas une simple gêne d'usage.
    logger.warn("[RateLimit][admin-adjustments] Limit hit", {
      userId: req.user && (req.user.id || req.user._id),
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      error:
        "Trop d'opérations d'ajustement de solde. Réessayez dans un instant.",
      retryAfter,
    });
  },
});

/* ------------------------------------------------------------------ */
/* 6) Limiteur global par user                                        */
/* ------------------------------------------------------------------ */
const userLimiter = rateLimit({
  name: "gw-user-global",
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method === "OPTIONS") return true;
    if (!req.user) return true;

    const url = req.originalUrl || req.path || "";

    // ✅ la route admin transactions a déjà son limiter dédié
    if (
      url === "/api/v1/admin/transactions" ||
      url.startsWith("/api/v1/admin/transactions/")
    ) {
      return true;
    }

    return false;
  },
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


/* ------------------------------------------------------------------ */
/* 8) Limiteur dédié aux encaissements PUBLICS (lien de cagnotte)      */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ C'EST LA SEULE LIMITE QUI VOIT LA VRAIE ADRESSE DU PAYEUR.
 *
 * `POST /api/v1/pay` est ouvert : le contributeur n'a pas de compte. Tx-Core,
 * en aval, EXEMPTE `/api/v1/collections/initiate` de son propre limiteur — et
 * il a raison de le faire, puisqu'il ne voit que l'adresse de la passerelle et
 * fondrait tous les payeurs en un seul compteur.
 *
 * Conséquence : si cette limite-ci disparaît, le chemin d'encaissement n'a plus
 * AUCUNE limite de bout en bout. Un même client peut alors marteler les
 * prestataires et faire naître autant d'intentions d'encaissement qu'il veut.
 *
 * Le seuil est volontairement bas : contribuer à une cagnotte est un geste
 * unique, pas une rafale. Un rejeu légitime (double clic, réseau qui bégaie)
 * porte la même clé d'idempotence et ne coûte rien — il n'a pas besoin d'un
 * quota généreux.
 */
const publicCollectionLimiter = rateLimit({
  name: "gw-public-collection",
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.PUBLIC_COLLECTION_RL_MAX || 12),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  keyGenerator: (req) => `paycollect:${getClientIp(req)}`,
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][public-collection] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(429).json({
      success: false,
      code: "TOO_MANY_COLLECTION_ATTEMPTS",
      error: "Trop de tentatives de paiement. Réessayez dans quelques minutes.",
      retryAfter,
    });
  },
});

module.exports = {
  globalIpLimiter,
  authLoginLimiter,
  meLimiter,
  announcementsLimiter,
  adminTransactionsLimiter,
  adminAdjustmentsLimiter,
  userLimiter,
  publicCollectionLimiter,
};