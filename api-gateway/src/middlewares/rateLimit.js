"use strict";

const crypto = require("crypto");
const rateLimit = require("./rateLimiter");
const config = require("../config");
const logger = require("../logger");
const { verifiedUserId } = require("../utils/accessToken");

/**
 * IP client : `utils/clientIp.js` — `req.ip` selon `trust proxy`, JAMAIS un
 * en-tête écrit par le client. Les CLÉS de limitation regroupent l'IPv6 en /64.
 */
const { getClientIp, rateLimitIpKey } = require("../utils/clientIp");

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
 * Empreinte de l'identifiant de connexion : ni l'e-mail ni le téléphone ne
 * doivent finir en clair dans une clé Redis ou un journal (règle B.4). HMAC
 * (clé dérivée du secret JWT) plutôt qu'un simple SHA-256, qu'un dictionnaire
 * d'adresses suffirait à inverser.
 */
const LOGIN_ID_KEY = crypto
  .createHmac("sha256", String(config.jwtSecret || ""))
  .update("paynoval/login-identifier/v1")
  .digest();

function loginIdentifierDigest(req) {
  const id = readLoginIdentifier(req);
  if (!id) return null;
  return crypto.createHmac("sha256", LOGIN_ID_KEY).update(id).digest("hex").slice(0, 32);
}

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
/**
 * PER ACCOUNT, NOT PER IP — 2026-09-30.
 *
 * The global shield keyed every request on the client IP (1200/min). Mobile
 * operators put thousands of subscribers behind the same carrier-grade NAT
 * address: at scale, legitimate users of Orange / MTN / Moov would have been
 * refused together because of their neighbours. Stripe and Wise limit per
 * ACCOUNT; Cloudflare-style edges add a much higher per-IP ceiling.
 *
 *   - request with a VERIFIED access token → bucket `acct:<userId>`;
 *   - anonymous request → bucket `ip:<ip>` (unchanged);
 *   - every request also counts in `ipCeilingLimiter`, a high per-IP ceiling
 *     that tolerates a whole NAT but stops a single machine's flood.
 *
 * The account id comes from a SIGNATURE-VERIFIED token
 * (`utils/accessToken.verifiedUserId`): keying on an unverified `sub` would let
 * a client spread its traffic over forged ids.
 */
const ACCOUNT_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_ACCOUNT_PER_MIN) || 1200;
const ANON_IP_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_ANON_IP_PER_MIN) || 1200;
const IP_CEILING_PER_MIN = Number(process.env.RATE_LIMIT_IP_CEILING_PER_MIN) || 30000;

function rateLimitSubject(req) {
  const userId = verifiedUserId(req);
  return userId ? `acct:${userId}` : `ip:${rateLimitIpKey(req)}`;
}

const globalIpLimiter = rateLimit({
  name: "gw-global-ip",
  windowMs: 60 * 1000,
  limit: (req) => (verifiedUserId(req) ? ACCOUNT_LIMIT_PER_MIN : ANON_IP_LIMIT_PER_MIN),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitSubject,
  skip: (req) => {
    if (req.method === "OPTIONS") return true;
    if (isLoginPath(req)) return true;
    if (isNoisyPath(req)) return true;
    return false;
  },
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][global] Limit hit", {
      subject: verifiedUserId(req) ? "account" : "ip",
      userId: verifiedUserId(req) || null,
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
      success: false,
      code: "RATE_LIMITED",
      error: "Trop de requêtes (protection globale). Réessaie dans un instant.",
      retryAfter,
    });
  },
});

const ipCeilingLimiter = rateLimit({
  name: "gw-ip-ceiling",
  windowMs: 60 * 1000,
  limit: IP_CEILING_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ipc:${rateLimitIpKey(req)}`,
  skip: (req) => req.method === "OPTIONS",
  handler: (req, res, _next, options) => {
    logger.warn("[RateLimit][ip-ceiling] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      method: req.method,
    });

    const retryAfter = setRetryAfter(res, options.windowMs);

    return res.status(options.statusCode || 429).json({
      success: false,
      code: "RATE_LIMITED",
      error: "Trop de requêtes depuis cette adresse. Réessaie dans un instant.",
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
    const ip = rateLimitIpKey(req);
    const id = loginIdentifierDigest(req) || "unknown";
    const p = req.path || "login";
    return `login:${ip}:${id}:${p}`;
  },
  handler: (req, res) => {
    logger.warn("[RateLimit][login] Limit hit", {
      ip: getClientIp(req),
      path: req.originalUrl,
      identifierDigest: loginIdentifierDigest(req),
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

/**
 * 2 bis) Anti « credential stuffing » PAR COMPTE — toutes IP confondues.
 *
 * Le limiteur précédent compte par (IP, compte) : une attaque répartie sur
 * mille adresses contre UN compte n'était jamais freinée. Pratique de
 * référence (« smart lockout » Okta / Microsoft, freinage par compte chez
 * Stripe) : un second compteur par compte, TEMPORAIRE (jamais un blocage
 * définitif qu'un attaquant pourrait déclencher à volonté), seuls les ÉCHECS
 * comptent, et le message est le même que celui du limiteur par IP — rien ne
 * révèle qu'un compte existe.
 */
const authAccountLimiter = rateLimit({
  name: "gw-auth-login-account",
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || !loginIdentifierDigest(req),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode < 400,
  keyGenerator: (req) => `login-acct:${loginIdentifierDigest(req)}`,
  handler: (req, res) => {
    logger.warn("[RateLimit][login-account] Limit hit", {
      ip: getClientIp(req),
      identifierDigest: loginIdentifierDigest(req),
    });

    const retryAfter = setRetryAfter(res, 15 * 60 * 1000);

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
    return uid ? `me:${uid}` : `meip:${rateLimitIpKey(req)}`;
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
    const ip = rateLimitIpKey(req);
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
    return uid ? `admin-tx:${uid}` : `admin-tx-ip:${rateLimitIpKey(req)}`;
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
    return uid ? `admin-adj:${uid}` : `admin-adj-ip:${rateLimitIpKey(req)}`;
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
    return uid ? `user:${uid}` : `ip:${rateLimitIpKey(req)}`;
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
  keyGenerator: (req) => `paycollect:${rateLimitIpKey(req)}`,
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
  ipCeilingLimiter,
  rateLimitSubject,
  authLoginLimiter,
  authAccountLimiter,
  loginIdentifierDigest,
  meLimiter,
  announcementsLimiter,
  adminTransactionsLimiter,
  adminAdjustmentsLimiter,
  userLimiter,
  publicCollectionLimiter,
};