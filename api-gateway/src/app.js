



// File: src/app.js
"use strict";

const crypto = require("crypto");

/* -------------------------------------------------------------------------- */
/* Production log guard                                                       */
/* -------------------------------------------------------------------------- */

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const SILENCE_PROD_LOGS = process.env.SILENCE_PROD_LOGS !== "false";
const SHOW_PROD_WARNINGS = process.env.SHOW_PROD_WARNINGS === "true";

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function isDuplicateMongooseIndexWarning(value) {
  const text =
    typeof value === "string"
      ? value
      : String(value?.message || value?.stack || value || "");

  return (
    text.includes("[MONGOOSE] Warning: Duplicate schema index") ||
    text.includes("Duplicate schema index")
  );
}

if (IS_PRODUCTION && SILENCE_PROD_LOGS) {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = (...args) => {
    const text = args.map((item) => String(item?.message || item || "")).join(" ");

    if (isDuplicateMongooseIndexWarning(text)) return;

    if (SHOW_PROD_WARNINGS) {
      originalConsole.warn(...args);
    }
  };
}

process.on("warning", (warning) => {
  if (IS_PRODUCTION && SILENCE_PROD_LOGS) {
    if (isDuplicateMongooseIndexWarning(warning)) return;

    if (SHOW_PROD_WARNINGS) {
      originalConsole.warn(warning?.stack || warning?.message || warning);
    }

    return;
  }

  originalConsole.warn(warning?.stack || warning?.message || warning);
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const xssClean = require("xss-clean");
const hpp = require("hpp");
const morgan = require("morgan");
const mongoose = require("mongoose");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const {
  createProxyMiddleware,
  fixRequestBody,
  responseInterceptor,
} = require("http-proxy-middleware");

const config = require("./config");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const path = require("path");
const openapiSpec = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

const { authMiddleware } = require("./middlewares/auth");
const {
  globalIpLimiter,
  authLoginLimiter,
  meLimiter,
  announcementsLimiter,
  adminTransactionsLimiter,
  adminAdjustmentsLimiter,
  userLimiter,
} = require("./middlewares/rateLimit");

const { loggerMiddleware } = require("./middlewares/logger");
const auditHeaders = require("./middlewares/auditHeaders");
const logger = require("./logger");
const { getAllProviders, getProvider } = require("./providers");

const paymentRoutes = require("../routes/payment");
const amlRoutes = require("../routes/aml");
const feesRoutes = require("../routes/fees");
const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
const userTransactionRoutes = require("../routes/transactions");
const adminComplianceRoutes = require("../routes/adminComplianceRoutes");

const internalTransactionsRouter = require("../routes/internalTransactions");
const internalRoutes = require("../routes/internalRoutes");
const pricingRoutes = require("../routes/pricingRoutes");
const fxRulesRoutes = require("../routes/fxRules");
const publicRoutes = require("../routes/publicRoutes");
const requirePublicSignature = require("./middlewares/requirePublicSignature");
const pricingRulesRoutes = require("../routes/pricingRulesRoutes");
const pricingChangeRequestsRoutes = require("../routes/pricingChangeRequestsRoutes");
const requireNotRestricted = require("./middlewares/requireNotRestricted");
const providerWebhooksRoutes = require("../routes/providerWebhookRoutes");

const app = express();

const shouldLogVerbose = !IS_PRODUCTION && config.nodeEnv !== "test";

/**
 * 1 = un proxy de confiance devant la gateway.
 */
app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

// Le navigateur envoie `scheme://host[:port]`, sans slash final. La config est
// déjà normalisée (voir src/config/index.js) mais on refait le passage ici pour
// que la comparaison reste juste quelle que soit la source de la valeur.
function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "*") return raw;
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function buildAllowedOriginsSet() {
  const set = new Set();

  const add = (origin) => {
    const normalized = normalizeOrigin(origin);
    if (normalized) set.add(normalized);
  };

  (config.cors?.origins || []).forEach(add);
  (config.cors?.adminOrigins || []).forEach(add);
  (config.cors?.mobileOrigins || []).forEach(add);

  // ⚠️ Les origines de développement ne doivent JAMAIS être acceptées en
  // production : une page servie depuis localhost pouvait sinon dialoguer avec
  // l'API de production avec `Allow-Credentials: true`.
  if (!IS_PRODUCTION) {
    [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ].forEach((origin) => set.add(origin));
  }

  return set;
}

const allowedOrigins = buildAllowedOriginsSet();
const allowAll =
  allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowAll) return true;
  return allowedOrigins.has(normalizeOrigin(origin));
}

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",

  "X-Request-Id",
  "x-request-id",

  "Idempotency-Key",
  "idempotency-key",
  "x-idempotency-key",

  "x-internal-token",
  "x-paynoval-internal-token",

  "Cache-Control",
  "Pragma",
  "Expires",
  "Accept",
  "Origin",

  "stripe-signature",
  "x-signature",
  "x-paynoval-signature",

  "X-Analytics-Key",
  "x-analytics-key",

  "X-Visitor-Id",
  "x-visitor-id",

  "X-Session-Id",
  "x-session-id",
];

const EXPOSED_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-Request-Id",
];

const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    if (config.cors?.allowCredentials !== false) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    res.setHeader("Access-Control-Allow-Methods", CORS_METHODS.join(","));
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

app.use((req, res, next) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

const corsMiddleware = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin)) return cb(null, true);

    /**
     * Un refus CORS est une décision de contrôle d'accès, JAMAIS une erreur
     * serveur. `cb(new Error(...))` remontait au gestionnaire d'erreurs global,
     * qui répondait 500 avec la stack complète : chaque connexion d'origine non
     * whitelistée noyait `logs/error.log` sous des incidents fantômes.
     *
     * `cb(null, false)` n'ajoute pas l'en-tête `Access-Control-Allow-Origin` —
     * le navigateur bloque alors la lecture de la réponse côté client, ce qui
     * EST le comportement CORS correct — sans transformer le refus en 500. La
     * sécurité est inchangée : aucune origine non listée ne reçoit d'en-tête
     * d'autorisation, et le CORS n'a jamais protégé des clients non-navigateur
     * (curl, service à service), pour lesquels la barrière d'auth JWT reste la
     * vraie protection.
     */
    return cb(null, false);
  },
  credentials: config.cors?.allowCredentials !== false,
  methods: CORS_METHODS,
  allowedHeaders: ALLOWED_HEADERS,
  exposedHeaders: EXPOSED_HEADERS,
  maxAge: 86400,
  optionsSuccessStatus: 204,
});

app.use((req, res, next) => {
  /**
   * socket.io ne passe PAS par le CORS HTTP du gateway.
   *
   * Le gateway n'est ici qu'un proxy transparent vers le serveur socket.io du
   * backend principal, qui gère lui-même l'origine et authentifie au handshake
   * JWT. Soumettre le transport polling de socket.io à ce middleware rejetait
   * toute connexion portant un `Origin` non whitelisté — y compris de vrais
   * clients web — alors que les WebSockets ne sont de toute façon pas soumis à
   * la same-origin policy : le contrôle n'apportait aucune sécurité et cassait
   * le transport. Le proxy est monté plus bas (`app.use("/socket.io", …)`).
   */
  if (req.path.startsWith("/socket.io")) return next();
  return corsMiddleware(req, res, next);
});

/* -------------------------------------------------------------------------- */
/* Security / parsing                                                         */
/* -------------------------------------------------------------------------- */

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(mongoSanitize());
app.use(xssClean());

app.use(
  hpp({
    whitelist: [
      "page",
      "limit",
      "sort",
      "provider",
      "status",
      "skip",
      "from",
      "to",
      "base",
      "quote",
      "days",
      "siteId",
      "groupBy",

      /**
       * Compliance filters
       */
      "code",
      "q",
      "search",
    ],
  })
);

if (shouldLogVerbose) {
  app.use(morgan(config.logging?.level === "debug" ? "dev" : "combined"));
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

if (shouldLogVerbose) {
  app.use(loggerMiddleware);
}

/* -------------------------------------------------------------------------- */
/* Rate limits spécifiques                                                    */
/* -------------------------------------------------------------------------- */

app.use("/api/v1/auth/login", authLoginLimiter);
app.use("/api/v1/auth/login-2fa", authLoginLimiter);
app.use("/api/v1/announcements", announcementsLimiter);

app.use("/api/v1", (req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isSocketIoRequest(req) {
  return req.path === "/socket.io" || req.path.startsWith("/socket.io/");
}

function isPrivilegedRole(req) {
  const role = String(req?.user?.role || "").toLowerCase();
  return ["admin", "superadmin", "support"].includes(role);
}

function logErrorInNonProd(message, meta = {}) {
  if (!shouldLogVerbose) return;

  try {
    logger.error?.(message, meta);
  } catch {}
}

function logWarnInNonProd(message, meta = {}) {
  if (!shouldLogVerbose) return;

  try {
    logger.warn?.(message, meta);
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Global IP limiter                                                          */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (isSocketIoRequest(req)) return next();
  return globalIpLimiter(req, res, next);
});

/* -------------------------------------------------------------------------- */
/* Public read-only limiter                                                   */
/* -------------------------------------------------------------------------- */

if (config.rateLimit?.public) {
  const publicLimiter = rateLimit({
    windowMs: config.rateLimit.public.windowMs,
    max: config.rateLimit.public.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    handler: (req, res) => {
      setCorsHeaders(req, res);
      res.status(429).json({
        success: false,
        message: "Trop de requêtes (public). Réessaie dans un instant.",
      });
    },
  });

  app.use("/api/v1/public", publicLimiter);
}

/* -------------------------------------------------------------------------- */
/* Docs / health                                                              */
/* -------------------------------------------------------------------------- */

app.get("/openapi.json", (_req, res) => res.json(openapiSpec));

app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: "PayNoval Gateway API",
  })
);

app.get("/", (_req, res) =>
  res.json({
    status: "ok",
    service: "api-gateway",
    ts: new Date().toISOString(),
  })
);

app.get("/api/v1", (_req, res) => {
  return res.status(200).json({
    success: true,
    service: "api-gateway",
    status: "ok",
    ts: new Date().toISOString(),
  });
});

app.get("/healthz", (_req, res) =>
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
  })
);

app.get("/status", async (_req, res) => {
  const statuses = {};

  await Promise.all(
    getAllProviders().map(async (name) => {
      const provider = getProvider(name);
      if (!provider || !provider.enabled) return;

      try {
        const health = await axios.get(
          provider.url + (provider.health || "/health"),
          {
            timeout: 3000,
          }
        );

        statuses[name] = {
          up: true,
          status: health.data?.status || "ok",
        };
      } catch (err) {
        statuses[name] = {
          up: false,
          error: err.message,
        };
      }
    })
  );

  res.json({
    gateway: "ok",
    microservices: statuses,
  });
});

/* -------------------------------------------------------------------------- */
/* Proxy backend principal                                                    */
/* -------------------------------------------------------------------------- */

const PRINCIPAL_BASE =
  config.principalUrl || process.env.PRINCIPAL_API_BASE_URL || "";

const PRINCIPAL_PREFIXES = [
  "/api/v1/auth",
  "/api/v1/users",
  "/api/v1/balance",
  "/api/v1/cagnottes",
  "/api/v1/vaults",
  "/api/v1/notifications",
  "/api/v1/cards",
  "/api/v1/bank-accounts",
  "/api/v1/mobiles",
  "/api/v1/paynovals",
  "/api/v1/chat",
  "/api/v1/devices",
  "/api/v1/verification",
  "/api/v1/kyc",
  "/api/v1/kyb",
  "/api/v1/badges",
  "/api/v1/upload",
  "/api/v1/rates",

  /**
   * IMPORTANT :
   * Toutes les routes admin non natives Gateway vont vers le backend principal.
   * Les routes natives Gateway comme /api/v1/admin/compliance doivent être montées
   * avant le proxy final.
   */
  "/api/v1/admin",

  "/api/v1/feedback",
  "/api/v1/contact",
  "/api/v1/reports",
  "/api/v1/jobs",
  "/api/v1/support",
  "/api/v1/tools",
  "/api/v1/moderation",
  "/api/v1/announcements",
  "/api/v1/referrals",
  "/api/v1/internal/referrals",
  "/api/v1/internal/referral",
  "/api/v1/fx",
  "/api/v1/analytics",
];

function makePrincipalProxy() {
  if (!PRINCIPAL_BASE) {
    logWarnInNonProd(
      "[PROXY] PRINCIPAL_BASE missing -> principal routes disabled"
    );
    return null;
  }

  const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

  return createProxyMiddleware({
    target: PRINCIPAL_BASE,
    changeOrigin: true,
    xfwd: true,
    ws: true,
    logLevel: IS_PRODUCTION ? "silent" : "debug",
    proxyTimeout: 30000,
    timeout: 30000,
    secure: !isHttp,
    selfHandleResponse: true,

    pathRewrite: (pathReq) => {
      if (pathReq.startsWith("/api/v1/analytics")) {
        return pathReq.replace(/^\/api\/v1\/analytics/, "/analytics");
      }

      return pathReq;
    },

    onProxyReq: (proxyReq, req, res) => {
      if (res?.headersSent || res?.writableEnded) return;

      try {
        fixRequestBody(proxyReq, req);
      } catch {}

      const requestId = req.headers["x-request-id"];

      if (requestId) {
        try {
          proxyReq.setHeader("X-Request-Id", requestId);
        } catch {}
      }

      if (req.headers.authorization) {
        try {
          proxyReq.setHeader("Authorization", req.headers.authorization);
        } catch {}
      }

      if (req.headers["idempotency-key"]) {
        try {
          proxyReq.setHeader("idempotency-key", req.headers["idempotency-key"]);
        } catch {}
      }

      if (req.headers["x-idempotency-key"]) {
        try {
          proxyReq.setHeader(
            "x-idempotency-key",
            req.headers["x-idempotency-key"]
          );
        } catch {}
      }

      if (req.headers["x-analytics-key"]) {
        try {
          proxyReq.setHeader("x-analytics-key", req.headers["x-analytics-key"]);
        } catch {}
      }

      if (req.headers["x-visitor-id"]) {
        try {
          proxyReq.setHeader("x-visitor-id", req.headers["x-visitor-id"]);
        } catch {}
      }

      if (req.headers["x-session-id"]) {
        try {
          proxyReq.setHeader("x-session-id", req.headers["x-session-id"]);
        } catch {}
      }

      if (config.principalInternalToken) {
        try {
          proxyReq.setHeader(
            "x-internal-token",
            String(config.principalInternalToken)
          );
        } catch {}
      }

      try {
        proxyReq.setHeader("x-forwarded-service", "api-gateway");
      } catch {}
    },

    onProxyRes: responseInterceptor(
      async (responseBuffer, proxyRes, req, res) => {
        const status = proxyRes.statusCode || 502;
        const contentType = String(proxyRes.headers["content-type"] || "");

        if (status === 429 && contentType.includes("text/html")) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return JSON.stringify({
            success: false,
            error: "UPSTREAM_RATE_LIMITED",
            message:
              "Le service principal a rejeté la requête (429). Cause probable : protection/anti-bot sur l'URL publique. Solution : utiliser l'Internal URL Render pour PRINCIPAL_URL.",
            path: req.originalUrl,
          });
        }

        if (status === 403 && contentType.includes("text/html")) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return JSON.stringify({
            success: false,
            error: "UPSTREAM_FORBIDDEN",
            message:
              "Le service principal a renvoyé un challenge/protection (403). Utilise l'Internal URL Render pour PRINCIPAL_URL.",
            path: req.originalUrl,
          });
        }

        return responseBuffer;
      }
    ),

    onError: (err, req, res) => {
      logErrorInNonProd("[PROXY principal] error", {
        message: err.message,
        path: req.originalUrl,
      });

      if (!res.headersSent) {
        setCorsHeaders(req, res);
        res.status(502).json({
          success: false,
          error: "Principal upstream unavailable",
        });
      }
    },
  });
}

function makePrincipalSocketProxy() {
  if (!PRINCIPAL_BASE) {
    logWarnInNonProd(
      "[SOCKET PROXY] PRINCIPAL_BASE missing -> socket proxy disabled"
    );
    return null;
  }

  const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

  return createProxyMiddleware({
    target: PRINCIPAL_BASE,
    changeOrigin: true,
    xfwd: true,
    ws: true,
    secure: !isHttp,
    logLevel: IS_PRODUCTION ? "silent" : "debug",
    proxyTimeout: 30000,
    timeout: 30000,

    onProxyReqWs: (proxyReq, req) => {
      try {
        const requestId = req.headers["x-request-id"];
        if (requestId) proxyReq.setHeader("X-Request-Id", requestId);

        if (config.principalInternalToken) {
          proxyReq.setHeader(
            "x-internal-token",
            String(config.principalInternalToken)
          );
        }

        proxyReq.setHeader("x-forwarded-service", "api-gateway");
      } catch {}
    },

    onError: (err, req, res) => {
      logErrorInNonProd("[SOCKET PROXY] error", {
        message: err.message,
        path: req.originalUrl,
      });

      if (res && !res.headersSent) {
        setCorsHeaders(req, res);
        res.status(502).json({
          success: false,
          error: "Principal socket upstream unavailable",
        });
      }
    },
  });
}

const principalProxy = makePrincipalProxy();
const principalSocketProxy = makePrincipalSocketProxy();

if (principalSocketProxy) {
  app.use("/socket.io", principalSocketProxy);
}

/* -------------------------------------------------------------------------- */
/* Auth global                                                                */
/* -------------------------------------------------------------------------- */

/**
 * BARRIÈRE D'AUTHENTIFICATION — ALLOWLIST EN REFUS PAR DÉFAUT
 * -----------------------------------------------------------------------------
 * ⚠️ CORRECTIF DE SÉCURITÉ. L'ancienne liste mélangeait deux natures de règles
 * dans un seul tableau évalué en « préfixe » :
 *
 *     const openEndpoints = ["/", "/api/v1", "/api/v1/auth", …];
 *     req.path === e || req.path.startsWith(e + "/")
 *
 * L'entrée "/api/v1" faisait donc passer TOUT chemin commençant par "/api/v1/"
 * — soit la totalité de l'API, y compris /api/v1/admin et /api/v1/users. La
 * barrière documentée ne filtrait plus rien. Aucune porte n'était réellement
 * ouverte (chaque routeur natif réapplique son propre garde, et le proxy fait
 * réauthentifier le backend principal), mais la défense en profondeur était
 * réduite à une seule couche : la prochaine route native qui aurait oublié son
 * garde aurait été publiquement accessible.
 *
 * Les deux natures sont désormais séparées :
 *   - OPEN_EXACT  : ouvert pour CE chemin seulement (racines d'information).
 *   - OPEN_PREFIX : ouvert pour ce chemin et tout son sous-arbre.
 */
const OPEN_EXACT = [
  "/",
  "/api/v1",
  "/healthz",
  "/status",
  "/openapi.json",

  /**
   * Appelés par l'app mobile AVANT toute connexion, via l'instance `publicApi`
   * qui n'attache jamais de jeton (aucun intercepteur d'authentification).
   *
   * Volontairement en EXACT et non en préfixe : `/api/v1/announcements/:id/seen`
   * reste protégé.
   *
   * `/api/v1/users/avatar-by-email` y a figuré brièvement, le temps de
   * constater que ses deux écrans appelants sont post-connexion. Le client
   * envoie désormais son jeton et la route est passée derrière `protect` côté
   * backend : elle n'a plus rien à faire ici.
   */
  "/api/v1/announcements",
];

const OPEN_PREFIX = [
  "/docs",
  "/socket.io",

  "/api/v1/auth",
  "/api/v1/verification",
  "/api/v1/public",

  "/api/v1/fees/simulate",
  "/api/v1/commissions/simulate",
  "/api/v1/exchange-rates/rate",
  "/api/v1/pricing",

  "/internal/transactions",
  "/api/v1/internal",
  "/api/v1/transactions/internal",

  "/api/v1/jobs",
  "/api/v1/contact",
  "/api/v1/reports",
  "/api/v1/feedback/threads",
  "/api/v1/provider-webhooks",
  "/api/v1/analytics",
];

/** Conservé pour compatibilité de lecture : plus aucun code ne doit s'en servir. */
const openEndpoints = [...OPEN_EXACT, ...OPEN_PREFIX];

function isOpenPath(path) {
  if (OPEN_EXACT.includes(path)) return true;
  return OPEN_PREFIX.some((e) => path === e || path.startsWith(e + "/"));
}

/**
 * Bascule de durcissement.
 *
 * `false` (défaut) = REPORT-ONLY : le comportement actuel est conservé et les
 * chemins qui *auraient* été bloqués sont journalisés. Cela permet de constituer
 * l'inventaire réel du trafic avant de verrouiller, sans risquer de couper un
 * parcours public non recensé — même logique qu'un CSP en report-only.
 *
 * `true` = la barrière refuse réellement. À activer une fois les logs
 * `[AUTH-BARRIER][REPORT]` silencieux en préproduction.
 */
const AUTH_BARRIER_STRICT =
  String(process.env.AUTH_BARRIER_STRICT || "").toLowerCase() === "true";

/**
 * Le mode observation ne doit journaliser QUE ce qui casserait réellement.
 *
 * ⚠️ Première version défectueuse : elle journalisait tout chemin hors
 * allowlist, y compris les requêtes porteuses d'un jeton valide — soit la
 * quasi-totalité du trafic de l'application. Des milliers de lignes indiquant
 * « sera protégé », qu'on lit naturellement comme « sera bloqué », alors que ces
 * requêtes passeraient sans encombre. Du bruit à la place du signal, et un
 * inventaire impossible à établir.
 *
 * Ce qui casserait en mode strict, c'est une requête SANS aucun identifiant
 * exploitable. C'est cela, et cela seul, qu'on veut voir.
 */
function hasUsableCredential(req) {
  const auth = String(req.headers.authorization || "");

  if (/^bearer\s+\S+/i.test(auth)) return true;
  if (req.headers["x-internal-token"]) return true;

  // Requête publique signée en HMAC (voir requirePublicSignature).
  if (req.headers["x-signature"] && req.headers["x-ts"]) return true;

  return false;
}

app.use((req, res, next) => {
  if (isOpenPath(req.path)) return next();

  if (!AUTH_BARRIER_STRICT) {
    // L'ancienne évaluation laissait tout /api/v1/* passer : on ne change pas
    // le comportement, on l'observe.
    const wasOpenBefore = req.path.startsWith("/api/v1/");

    if (wasOpenBefore) {
      if (!hasUsableCredential(req)) {
        logger.warn(
          `[AUTH-BARRIER][WOULD-BLOCK] ${req.method} ${req.path} — sans identifiant, ` +
            `cette requête sera REFUSÉE quand AUTH_BARRIER_STRICT=true`
        );
      }

      return next();
    }
  }

  return authMiddleware(req, res, next);
});

/* -------------------------------------------------------------------------- */
/* Public signed routes                                                       */
/* -------------------------------------------------------------------------- */

app.use("/api/v1/public", (req, res, next) => {
  const openPublicFx = req.path === "/fx/latest" || req.path === "/fx/history";

  if (openPublicFx) {
    return next();
  }

  if (!config.publicReadonlySecret) {
    return res.status(503).json({
      success: false,
      message:
        "Public read-only is not configured (missing PUBLIC_READONLY_HMAC_SECRET).",
    });
  }

  return requirePublicSignature(req, res, next);
});

app.use("/api/v1/public", publicRoutes);

/* -------------------------------------------------------------------------- */
/* Post-auth middleware                                                       */
/* -------------------------------------------------------------------------- */

app.use(auditHeaders);

app.use("/api/v1/users/me", (req, res, next) => {
  if (isPrivilegedRole(req)) return next();
  return meLimiter(req, res, next);
});

app.use((req, res, next) => {
  if (isSocketIoRequest(req)) return next();
  if (isPrivilegedRole(req)) return next();

  if (
    req.path === "/api/v1/provider-webhooks" ||
    req.path.startsWith("/api/v1/provider-webhooks/")
  ) {
    return next();
  }

  return userLimiter(req, res, next);
});

/* -------------------------------------------------------------------------- */
/* Mongo readiness for native gateway routes only                             */
/* -------------------------------------------------------------------------- */

const mongoRequiredPrefixes = [
  "/api/v1/aml",
  "/api/v1/fees",
  "/api/v1/commissions",
  "/api/v1/exchange-rates",
  "/api/v1/pricing",
  "/api/v1/fx-rules",
  "/api/v1/pricing-rules",
  "/api/v1/pricing-change-requests",
];

app.use((req, res, next) => {
  const needsMongo = mongoRequiredPrefixes.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + "/")
  );

  if (!needsMongo) return next();

  if (mongoose.connection.readyState !== 1) {
    logErrorInNonProd("[MONGO] Requête refusée, MongoDB non connecté !");

    return res.status(500).json({
      success: false,
      error: "MongoDB non connecté",
    });
  }

  return next();
});

/* -------------------------------------------------------------------------- */
/* Native gateway routes                                                      */
/* -------------------------------------------------------------------------- */

app.use("/api/v1/provider-webhooks", providerWebhooksRoutes);

app.use("/api/v1/pay", paymentRoutes);
app.use("/internal/transactions", internalTransactionsRouter);
app.use("/api/v1/internal", internalRoutes);
app.use("/api/v1/transactions", userTransactionRoutes);

/**
 * IMPORTANT :
 * Ancienne route native supprimée :
 *
 * const transactionRoutes = require("../routes/admin/transactions.admin.routes");
 * app.use("/api/v1/admin/transactions", adminTransactionsLimiter, transactionRoutes);
 *
 * Maintenant, /api/v1/admin/transactions part vers le backend principal.
 * On garde seulement le limiter, puis on laisse la requête continuer jusqu’au proxy final.
 */
app.use("/api/v1/admin/transactions", adminTransactionsLimiter);

/**
 * Ajustements manuels de solde — crédit / débit d'un compte client décidé au
 * back-office.
 *
 * Comme `/api/v1/admin/transactions`, la route n'est PAS native : seul le
 * limiteur est appliqué ici, puis la requête poursuit jusqu'au proxy final vers
 * le backend principal, qui détient la double validation demandeur ≠ valideur.
 *
 * Ce montage doit rester AVANT le proxy `/api/v1/admin`, sinon le limiteur ne
 * s'applique jamais : le proxy absorberait la requête en amont.
 *
 * Endpoints (portés par le principal) :
 *   GET  /api/v1/admin/adjustments            — file des demandes
 *   POST /api/v1/admin/adjustments            — créer une demande
 *   POST /api/v1/admin/adjustments/:id/approve
 *   POST /api/v1/admin/adjustments/:id/reject
 */
app.use("/api/v1/admin/adjustments", adminAdjustmentsLimiter);

/**
 * Conformité transactions :
 * Cette route doit rester AVANT le proxy final /api/v1/admin,
 * sinon elle sera envoyée au backend principal.
 *
 * Endpoint :
 * GET /api/v1/admin/compliance/transactions
 */
app.use(
  "/api/v1/admin/compliance",
  adminTransactionsLimiter,
  adminComplianceRoutes
);

app.use("/api/v1/aml", amlRoutes);
app.use("/api/v1/fees", feesRoutes);
app.use("/api/v1/exchange-rates", exchangeRateRoutes);

/**
 * /api/v1/pricing est ouvert sans JWT : le simulateur public en dépend. Il
 * reste donc borné par un limiteur qui lui est propre, dimensionné pour un
 * usage de simulateur et non de boucle automatisée.
 *
 * Chaque devis déclenche une lecture des règles (servie par le cache) et, si le
 * corridor n'est pas en PASS_THROUGH figé, un appel FX externe.
 */
const pricingQuoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.PRICING_QUOTE_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  handler: (req, res) => {
    setCorsHeaders(req, res);
    res.status(429).json({
      success: false,
      message: "Trop de simulations tarifaires. Réessayez dans une minute.",
    });
  },
});

app.use("/api/v1/pricing", pricingQuoteLimiter);
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/fx-rules", fxRulesRoutes);
app.use("/api/v1/pricing-rules", pricingRulesRoutes);
app.use("/api/v1/pricing-change-requests", pricingChangeRequestsRoutes);

/**
 * Surfaces PROXIFIÉES sensibles : le gateway les transmet au backend principal
 * sans les faire passer par `requireTransactionEligibility`, monté uniquement
 * sur les routes de transaction natives.
 *
 * Le garde s'applique donc ici, avant le proxy final. Le backend principal
 * refait le même contrôle : c'est une défense en profondeur, pas un doublon
 * inutile — la règle vaut aussi bien pour le web que pour l'application mobile,
 * puisque les deux passent par ce gateway.
 */
app.use(
  "/api/v1/cagnottes",
  requireNotRestricted({
    methods: ["POST"],
    /**
     * Chemins bloqués, et EUX SEULS. Ce qui envoie de l'argent à un autre
     * utilisateur PayNoval, ou crée une collecte :
     *   POST /                                → création
     *   POST /:id/join                        → participation (porte un montant)
     *   POST /:id/participations/paynoval     → participation sur solde PayNoval
     *
     * Restent ouverts, volontairement :
     *   POST /:id/close                       → un compte restreint doit pouvoir
     *                                           liquider sa propre cagnotte
     *   POST /:id/subscribe                   → simple abonnement, aucun argent
     *   POST /:id/external-payment-callback   → webhook provider, authentifié par
     *                                           token gateway et sans req.user
     */
    paths: [
      /^\/$/,
      /^\/[^/]+\/join$/,
      /^\/[^/]+\/participations\/paynoval$/,
    ],
  })
);

/* -------------------------------------------------------------------------- */
/* Final proxy to principal backend                                           */
/* -------------------------------------------------------------------------- */

if (principalProxy) {
  const uniquePrefixes = Array.from(new Set(PRINCIPAL_PREFIXES));

  uniquePrefixes.forEach((prefix) => {
    app.use(prefix, principalProxy);
  });
}

/* -------------------------------------------------------------------------- */
/* 404                                                                        */
/* -------------------------------------------------------------------------- */

app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: "Ressource non trouvée",
  })
);

/* -------------------------------------------------------------------------- */
/* Error handler                                                              */
/* -------------------------------------------------------------------------- */

app.use((err, req, res, _next) => {
  const status = err.status || 500;

  // ⚠️ Le log était enfermé dans `if (!IS_PRODUCTION)` : aucune erreur n'était
  // tracée en production, donc aucun incident diagnosticable. On journalise
  // TOUJOURS, avec un identifiant de corrélation renvoyé au client.
  const requestId =
    req.headers["x-request-id"] ||
    req.id ||
    crypto.randomUUID?.() ||
    String(Date.now());

  logger.error("[API ERROR]", {
    requestId,
    message: err.message,
    stack: err.stack,
    status,
    path: req.originalUrl,
    method: req.method,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
    user: req.user?.email,
    // Le corps n'est journalisé qu'hors production : il peut contenir des
    // données personnelles ou des identifiants.
    ...(IS_PRODUCTION ? {} : { body: req.body }),
  });

  setCorsHeaders(req, res);
  res.setHeader("X-Request-Id", String(requestId));

  // Les erreurs de validation Joi sont utiles au client et ne fuient rien.
  if (err.isJoi && err.details) {
    return res.status(status).json({
      success: false,
      error: err.details.map((detail) => detail.message).join("; "),
      requestId,
    });
  }

  // ⚠️ `err.message` brut pouvait exposer des URL internes, des noms de
  // collection Mongo ou des détails d'implémentation. En production, on ne
  // renvoie le message que pour les erreurs métier explicites (4xx).
  const isClientError = status >= 400 && status < 500;
  const exposeMessage = !IS_PRODUCTION || isClientError;

  return res.status(status).json({
    success: false,
    error: exposeMessage ? err.message || "Erreur serveur" : "Erreur serveur",
    requestId,
  });
});

module.exports = app;