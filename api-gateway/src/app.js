// // File: src/app.js
// "use strict";

// const express = require("express");
// const cors = require("cors");
// const helmet = require("helmet");
// const mongoSanitize = require("express-mongo-sanitize");
// const xssClean = require("xss-clean");
// const hpp = require("hpp");
// const morgan = require("morgan");
// const mongoose = require("mongoose");
// const axios = require("axios");
// const rateLimit = require("express-rate-limit");
// const {
//   createProxyMiddleware,
//   fixRequestBody,
//   responseInterceptor,
// } = require("http-proxy-middleware");

// // ✅ Config
// const config = require("./config");

// // ✅ Swagger (docs Gateway)
// const swaggerUi = require("swagger-ui-express");
// const YAML = require("yamljs");
// const path = require("path");
// const openapiSpec = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

// // ✅ Middlewares internes
// const { authMiddleware } = require("./middlewares/auth");
// const {
//   globalIpLimiter,
//   authLoginLimiter,
//   meLimiter,
//   announcementsLimiter,
//   userLimiter,
// } = require("./middlewares/rateLimit");
// const { loggerMiddleware } = require("./middlewares/logger");
// const auditHeaders = require("./middlewares/auditHeaders");
// const logger = require("./logger");
// const { getAllProviders, getProvider } = require("./providers");

// // ✅ Routes (gateway natives)
// const paymentRoutes = require("../routes/payment");
// const amlRoutes = require("../routes/aml");
// const transactionRoutes = require("../routes/admin/transactions.admin.routes");
// const feesRoutes = require("../routes/fees");
// const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
// const commissionsRoutes = require("../routes/commissionsRoutes");
// const userTransactionRoutes = require("../routes/transactions");

// // legacy internal
// const internalTransactionsRouter = require("../routes/internalTransactions");
// const internalRoutes = require("../routes/internalRoutes");

// // phone verification
// const phoneVerificationRoutes = require("../routes/phoneVerificationRoutes");

// // pricing + fx rules
// const pricingRoutes = require("../routes/pricingRoutes");
// const fxRulesRoutes = require("../routes/fxRules");

// // public read-only (HMAC signed)
// const publicRoutes = require("../routes/publicRoutes");
// const requirePublicSignature = require("./middlewares/requirePublicSignature");

// const app = express();

// // Logs
// try {
//   logger.info?.("[BOOT] env=" + (config.nodeEnv || process.env.NODE_ENV));
//   logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
//   logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
//   logger.info?.("[BOOT] PRINCIPAL_URL=" + String(config.principalUrl || ""));
// } catch (_) {}

// // ✅ IMPORTANT: Render/Cloudflare => plusieurs proxies
// app.set("trust proxy", true);

// // ─────────────────────────────────────────────────────────────
// // ✅ CORS (robuste même en cas d'erreurs/429)
// // ─────────────────────────────────────────────────────────────
// function buildAllowedOriginsSet() {
//   const set = new Set();
//   (config.cors?.origins || []).forEach((o) => set.add(o));
//   (config.cors?.adminOrigins || []).forEach((o) => set.add(o));
//   (config.cors?.mobileOrigins || []).forEach((o) => set.add(o));
//   return set;
// }

// const allowedOrigins = buildAllowedOriginsSet();
// const allowAll =
//   allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

// function isOriginAllowed(origin) {
//   if (!origin) return true; // SSR/Postman
//   if (allowAll) return true;
//   return allowedOrigins.has(origin);
// }

// // ✅ Toujours poser CORS headers si origin autorisée (même pour 429/500)
// app.use((req, res, next) => {
//   const origin = req.headers.origin;

//   if (origin && isOriginAllowed(origin)) {
//     res.setHeader("Access-Control-Allow-Origin", origin);
//     res.setHeader("Vary", "Origin");
//     if (config.cors?.allowCredentials !== false) {
//       res.setHeader("Access-Control-Allow-Credentials", "true");
//     }
//     res.setHeader(
//       "Access-Control-Expose-Headers",
//       "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining"
//     );
//   }

//   // Préflight rapide
//   if (req.method === "OPTIONS") {
//     res.setHeader(
//       "Access-Control-Allow-Methods",
//       "GET,POST,PUT,PATCH,DELETE,OPTIONS"
//     );
//     res.setHeader(
//       "Access-Control-Allow-Headers",
//       "Content-Type, Authorization, X-Requested-With, X-Request-Id, x-internal-token"
//     );
//     return res.sendStatus(204);
//   }

//   next();
// });

// // cors package (pour compatibilité)
// app.use(
//   cors({
//     origin: (origin, cb) => {
//       if (!origin) return cb(null, true);
//       if (isOriginAllowed(origin)) return cb(null, origin);
//       return cb(null, false);
//     },
//     credentials: config.cors?.allowCredentials !== false,
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//     allowedHeaders: [
//       "Content-Type",
//       "Authorization",
//       "X-Requested-With",
//       "X-Request-Id",
//       "x-internal-token",
//     ],
//     exposedHeaders: [
//       "Retry-After",
//       "X-RateLimit-Limit",
//       "X-RateLimit-Remaining",
//     ],
//     maxAge: 86400,
//   })
// );

// // ─────────── SÉCURITÉ & LOG ───────────
// app.use(
//   helmet({
//     crossOriginResourcePolicy: false,
//   })
// );

// app.use(mongoSanitize());
// app.use(xssClean());
// app.use(
//   hpp({
//     whitelist: [
//       "page",
//       "limit",
//       "sort",
//       "provider",
//       "status",
//       "skip",
//       "from",
//       "to",
//       "base",
//       "quote",
//       "days",
//     ],
//   })
// );

// if (config.nodeEnv !== "test") {
//   app.use(morgan(config.logging?.level === "debug" ? "dev" : "combined"));
// }

// // ✅ Body parser AVANT login limiter
// app.use(express.json({ limit: "2mb" }));
// app.use(loggerMiddleware);

// // ✅ Anti brute-force login (après json)
// app.use("/api/v1/auth/login", authLoginLimiter);
// app.use("/api/v1/auth/login-2fa", authLoginLimiter);

// // 3) announcements (public)
// app.use("/api/v1/announcements", announcementsLimiter);

// // 🛡️ Bouclier global IP (skip noisy géré dedans)
// app.use((req, res, next) => globalIpLimiter(req, res, next));

// // ─────────── RATE LIMIT spécial /public (read-only) ───────────
// if (config.rateLimit?.public) {
//   const publicLimiter = rateLimit({
//     windowMs: config.rateLimit.public.windowMs,
//     max: config.rateLimit.public.max,
//     standardHeaders: true,
//     legacyHeaders: false,
//     skip: (req) => req.method === "OPTIONS",
//     handler: (_req, res) => {
//       res.status(429).json({
//         success: false,
//         message: "Trop de requêtes (public). Réessaie dans un instant.",
//       });
//     },
//   });
//   app.use("/api/v1/public", publicLimiter);
// }

// // ─────────── DOCS ───────────
// app.get("/openapi.json", (_req, res) => res.json(openapiSpec));
// app.use(
//   "/docs",
//   swaggerUi.serve,
//   swaggerUi.setup(openapiSpec, {
//     explorer: true,
//     customSiteTitle: "PayNoval Gateway API",
//   })
// );

// // ─────────── HEALTH / STATUS ───────────
// app.get("/", (_req, res) =>
//   res.json({
//     status: "ok",
//     service: "api-gateway",
//     ts: new Date().toISOString(),
//   })
// );

// app.get("/api/v1", (_req, res) => {
//   res.setHeader("Cache-Control", "no-store");
//   return res.status(200).json({
//     success: true,
//     service: "api-gateway",
//     status: "ok",
//     ts: new Date().toISOString(),
//   });
// });

// app.get("/healthz", (_req, res) =>
//   res.json({ status: "ok", ts: new Date().toISOString() })
// );

// app.get("/status", async (_req, res) => {
//   const statuses = {};
//   await Promise.all(
//     getAllProviders().map(async (name) => {
//       const p = getProvider(name);
//       if (!p || !p.enabled) return;
//       try {
//         const health = await axios.get(p.url + (p.health || "/health"), {
//           timeout: 3000,
//         });
//         statuses[name] = { up: true, status: health.data?.status || "ok" };
//       } catch (err) {
//         statuses[name] = { up: false, error: err.message };
//       }
//     })
//   );
//   res.json({ gateway: "ok", microservices: statuses });
// });

// // ─────────────────────────────────────────────────────────────
// // ✅ PROXY vers BACKEND PRINCIPAL
// // ─────────────────────────────────────────────────────────────
// //
// // ⚠️ IMPORTANT:
// // Mets PRINCIPAL_URL sur l'Internal URL Render du service paynoval-backend
// // pour éviter les 429 Cloudflare/Front-door sur l'URL publique.
// //
// const PRINCIPAL_BASE =
//   config.principalUrl || process.env.PRINCIPAL_API_BASE_URL || "";

// const PRINCIPAL_PREFIXES = [
//   "/api/v1/auth",
//   "/api/v1/users",
//   "/api/v1/balance",
//   "/api/v1/cagnottes",
//   "/api/v1/vaults",
//   "/api/v1/notifications",
//   "/api/v1/cards",
//   "/api/v1/bank-accounts",
//   "/api/v1/mobiles",
//   "/api/v1/paynovals",
//   "/api/v1/chat",
//   "/api/v1/devices",
//   "/api/v1/verification",
//   "/api/v1/kyc",
//   "/api/v1/badges",
//   "/api/v1/upload",
//   "/api/v1/rates",

//   "/api/v1/admin",
//   "/api/v1/feedback",
//   "/api/v1/contact",
//   "/api/v1/reports",
//   "/api/v1/jobs",
//   "/api/v1/support",
//   "/api/v1/tools",

//   "/api/v1/moderation",
//   "/api/v1/announcements",
// ];

// function makePrincipalProxy() {
//   if (!PRINCIPAL_BASE) {
//     logger.warn?.("[PROXY] PRINCIPAL_BASE missing -> principal routes disabled");
//     return null;
//   }

//   const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

//   return createProxyMiddleware({
//     target: PRINCIPAL_BASE,
//     changeOrigin: true,
//     xfwd: true,
//     ws: true,
//     logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
//     proxyTimeout: 30000,
//     timeout: 30000,

//     // ✅ si le target est http (souvent sur internal URL), on ne force pas TLS verify
//     secure: !isHttp,

//     // ✅ Permet de remplacer le body quand upstream renvoie HTML (Cloudflare challenge)
//     selfHandleResponse: true,

//     onProxyReq: (proxyReq, req, res) => {
//       if (res?.headersSent || res?.writableEnded) return;

//       try {
//         fixRequestBody(proxyReq, req);
//       } catch (_) {}

//       const rid = req.headers["x-request-id"];
//       if (rid) {
//         try {
//           proxyReq.setHeader("X-Request-Id", rid);
//         } catch (_) {}
//       }

//       if (req.headers.authorization) {
//         try {
//           proxyReq.setHeader("Authorization", req.headers.authorization);
//         } catch (_) {}
//       }

//       if (config.principalInternalToken) {
//         try {
//           proxyReq.setHeader(
//             "x-internal-token",
//             String(config.principalInternalToken)
//           );
//         } catch (_) {}
//       }

//       try {
//         proxyReq.setHeader("x-forwarded-service", "api-gateway");
//       } catch (_) {}
//     },

//     onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
//       const status = proxyRes.statusCode || 502;
//       const ct = String(proxyRes.headers["content-type"] || "");

//       // ✅ Cas typique: 429 + HTML "Just a moment..." (Cloudflare)
//       if (status === 429 && ct.includes("text/html")) {
//         res.setHeader("Content-Type", "application/json; charset=utf-8");
//         return JSON.stringify({
//           success: false,
//           error: "UPSTREAM_RATE_LIMITED",
//           message:
//             "Le service principal a rejeté la requête (429). " +
//             "Cause probable: protection/anti-bot sur l'URL publique. " +
//             "Solution: utiliser l'Internal URL Render pour PRINCIPAL_URL.",
//           path: req.originalUrl,
//         });
//       }

//       // ✅ Cas 403 HTML aussi (challenge)
//       if (status === 403 && ct.includes("text/html")) {
//         res.setHeader("Content-Type", "application/json; charset=utf-8");
//         return JSON.stringify({
//           success: false,
//           error: "UPSTREAM_FORBIDDEN",
//           message:
//             "Le service principal a renvoyé un challenge/protection (403). " +
//             "Utilise l'Internal URL Render pour PRINCIPAL_URL.",
//           path: req.originalUrl,
//         });
//       }

//       // Sinon => renvoyer tel quel
//       return responseBuffer;
//     }),

//     onError: (err, req, res) => {
//       logger.error("[PROXY principal] error", {
//         message: err.message,
//         path: req.originalUrl,
//       });
//       if (!res.headersSent) {
//         res.status(502).json({
//           success: false,
//           error: "Principal upstream unavailable",
//         });
//       }
//     },
//   });
// }

// const principalProxy = makePrincipalProxy();

// // ─────────── AUTH GLOBAL GATEWAY ───────────
// const openEndpoints = [
//   "/",
//   "/api/v1",
//   "/healthz",
//   "/status",
//   "/docs",
//   "/openapi.json",

//   "/api/v1/auth",
//   "/api/v1/verification",

//   "/api/v1/public",

//   "/api/v1/fees/simulate",
//   "/api/v1/commissions/simulate",
//   "/api/v1/exchange-rates/rate",

//   "/internal/transactions",
//   "/api/v1/internal",

//   // ✅ IMPORTANT: laisser passer la route interne transactions (elle gère son token interne elle-même)
//   "/api/v1/transactions/internal",

//   "/api/v1/jobs",
//   "/api/v1/contact",
//   "/api/v1/reports",
//   "/api/v1/feedback/threads",
// ];

// app.use((req, res, next) => {
//   const isOpen = openEndpoints.some(
//     (ep) => req.path === ep || req.path.startsWith(ep + "/")
//   );
//   if (isOpen) return next();
//   return authMiddleware(req, res, next);
// });

// // ─────────── /public : signature HMAC obligatoire ───────────
// app.use("/api/v1/public", (req, res, next) => {
//   if (!config.publicReadonlySecret) {
//     return res.status(503).json({
//       success: false,
//       message:
//         "Public read-only is not configured (missing PUBLIC_READONLY_HMAC_SECRET).",
//     });
//   }
//   return requirePublicSignature(req, res, next);
// });
// app.use("/api/v1/public", publicRoutes);

// // audit headers après auth
// app.use(auditHeaders);

// // ✅ Limiteur spécial /users/me (après auth => req.user dispo)
// app.use("/api/v1/users/me", (req, res, next) => meLimiter(req, res, next));

// // ✅ user limiter global (protégé)
// app.use((req, res, next) => userLimiter(req, res, next));

// // ─────────── DB READY STATE (routes DB gateway only) ───────────
// const mongoRequiredPrefixes = [
//   "/api/v1/admin",
//   "/api/v1/aml",
//   "/api/v1/fees",
//   "/api/v1/commissions",
//   "/api/v1/exchange-rates",
//   "/api/v1/pricing",
//   "/api/v1/fx-rules",
//   "/api/v1/phone-verification",
// ];

// app.use((req, res, next) => {
//   const needsMongo = mongoRequiredPrefixes.some(
//     (p) => req.path === p || req.path.startsWith(p + "/")
//   );
//   if (!needsMongo) return next();

//   if (mongoose.connection.readyState !== 1) {
//     logger.error("[MONGO] Requête refusée, MongoDB non connecté !");
//     return res.status(500).json({ success: false, error: "MongoDB non connecté" });
//   }
//   return next();
// });

// // ─────────── ROUTES GATEWAY NATIVES ───────────
// app.use("/api/v1/pay", paymentRoutes);
// app.use("/internal/transactions", internalTransactionsRouter);
// app.use("/api/v1/internal", internalRoutes);
// app.use("/api/v1/transactions", userTransactionRoutes);
// app.use("/api/v1/admin/transactions", transactionRoutes);
// app.use("/api/v1/aml", amlRoutes);
// app.use("/api/v1/fees", feesRoutes);
// app.use("/api/v1/exchange-rates", exchangeRateRoutes);
// app.use("/api/v1/commissions", commissionsRoutes);
// app.use("/api/v1/pricing", pricingRoutes);
// app.use("/api/v1/fx-rules", fxRulesRoutes);
// app.use("/api/v1/phone-verification", phoneVerificationRoutes);


// // ✅ PROXY FINAL: routes du backend principal
// if (principalProxy) {
//   const uniq = Array.from(new Set(PRINCIPAL_PREFIXES));
//   uniq.forEach((prefix) => app.use(prefix, principalProxy));
// }

// // 404
// app.use((req, res) =>
//   res.status(404).json({ success: false, error: "Ressource non trouvée" })
// );

// // error handler
// app.use((err, req, res, _next) => {
//   logger.error("[API ERROR]", {
//     message: err.message,
//     stack: err.stack,
//     status: err.status,
//     path: req.originalUrl,
//     method: req.method,
//     ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
//     userAgent: req.headers["user-agent"],
//     user: req.user?.email,
//     body: req.body,
//   });

//   res.status(err.status || 500).json({
//     success: false,
//     error:
//       err.isJoi && err.details
//         ? err.details.map((d) => d.message).join("; ")
//         : err.message || "Erreur serveur",
//   });
// });

// module.exports = app;






// File: src/app.js
"use strict";

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
  userLimiter,
} = require("./middlewares/rateLimit");
const { loggerMiddleware } = require("./middlewares/logger");
const auditHeaders = require("./middlewares/auditHeaders");
const logger = require("./logger");
const { getAllProviders, getProvider } = require("./providers");

const paymentRoutes = require("../routes/payment");
const amlRoutes = require("../routes/aml");
const transactionRoutes = require("../routes/admin/transactions.admin.routes");
const feesRoutes = require("../routes/fees");
const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
const commissionsRoutes = require("../routes/commissionsRoutes");
const userTransactionRoutes = require("../routes/transactions");

const internalTransactionsRouter = require("../routes/internalTransactions");
const internalRoutes = require("../routes/internalRoutes");

const phoneVerificationRoutes = require("../routes/phoneVerificationRoutes");

const pricingRoutes = require("../routes/pricingRoutes");
const fxRulesRoutes = require("../routes/fxRules");

const publicRoutes = require("../routes/publicRoutes");
const requirePublicSignature = require("./middlewares/requirePublicSignature");

const app = express();

try {
  logger.info?.("[BOOT] env=" + (config.nodeEnv || process.env.NODE_ENV));
  logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
  logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
  logger.info?.("[BOOT] PRINCIPAL_URL=" + String(config.principalUrl || ""));
} catch (_) {}

app.set("trust proxy", true);

// ─────────────────────────────────────────────────────────────
// ✅ CORS robuste
// ─────────────────────────────────────────────────────────────
function buildAllowedOriginsSet() {
  const set = new Set();

  (config.cors?.origins || []).forEach((o) => o && set.add(o));
  (config.cors?.adminOrigins || []).forEach((o) => o && set.add(o));
  (config.cors?.mobileOrigins || []).forEach((o) => o && set.add(o));

  // ✅ garde-fous utiles en local
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].forEach((o) => set.add(o));

  return set;
}

const allowedOrigins = buildAllowedOriginsSet();
const allowAll =
  allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

function isOriginAllowed(origin) {
  if (!origin) return true; // Postman / curl / SSR / mobile natif
  if (allowAll) return true;
  return allowedOrigins.has(origin);
}

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "X-Request-Id",
  "x-request-id",
  "x-internal-token",
  "Cache-Control",
  "Pragma",
  "Expires",
  "Accept",
  "Origin",
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

// ✅ Toujours poser CORS headers si origin autorisée (même pour 429/500)
app.use((req, res, next) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ✅ cors package en complément
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: config.cors?.allowCredentials !== false,
    methods: CORS_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 86400,
    optionsSuccessStatus: 204,
  })
);

// ─────────── SÉCURITÉ & LOG ───────────
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
    ],
  })
);

if (config.nodeEnv !== "test") {
  app.use(morgan(config.logging?.level === "debug" ? "dev" : "combined"));
}

// ✅ Body parser AVANT login limiter
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(loggerMiddleware);

// ✅ Anti brute-force login
app.use("/api/v1/auth/login", authLoginLimiter);
app.use("/api/v1/auth/login-2fa", authLoginLimiter);

// ✅ annonces publiques
app.use("/api/v1/announcements", announcementsLimiter);

// ✅ anti-cache côté serveur (et non côté navigateur)
app.use("/api/v1", (req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// 🛡️ Bouclier global IP
app.use((req, res, next) => globalIpLimiter(req, res, next));

// ─────────── RATE LIMIT spécial /public ───────────
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

// ─────────── DOCS ───────────
app.get("/openapi.json", (_req, res) => res.json(openapiSpec));
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: "PayNoval Gateway API",
  })
);

// ─────────── HEALTH / STATUS ───────────
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
  res.json({ status: "ok", ts: new Date().toISOString() })
);

app.get("/status", async (_req, res) => {
  const statuses = {};

  await Promise.all(
    getAllProviders().map(async (name) => {
      const p = getProvider(name);
      if (!p || !p.enabled) return;

      try {
        const health = await axios.get(p.url + (p.health || "/health"), {
          timeout: 3000,
        });
        statuses[name] = { up: true, status: health.data?.status || "ok" };
      } catch (err) {
        statuses[name] = { up: false, error: err.message };
      }
    })
  );

  res.json({ gateway: "ok", microservices: statuses });
});

// ─────────────────────────────────────────────────────────────
// ✅ PROXY vers BACKEND PRINCIPAL
// ─────────────────────────────────────────────────────────────
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
  "/api/v1/badges",
  "/api/v1/upload",
  "/api/v1/rates",

  "/api/v1/admin",
  "/api/v1/feedback",
  "/api/v1/contact",
  "/api/v1/reports",
  "/api/v1/jobs",
  "/api/v1/support",
  "/api/v1/tools",

  "/api/v1/moderation",
  "/api/v1/announcements",
];

function makePrincipalProxy() {
  if (!PRINCIPAL_BASE) {
    logger.warn?.("[PROXY] PRINCIPAL_BASE missing -> principal routes disabled");
    return null;
  }

  const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

  return createProxyMiddleware({
    target: PRINCIPAL_BASE,
    changeOrigin: true,
    xfwd: true,
    ws: true,
    logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
    proxyTimeout: 30000,
    timeout: 30000,
    secure: !isHttp,
    selfHandleResponse: true,

    onProxyReq: (proxyReq, req, res) => {
      if (res?.headersSent || res?.writableEnded) return;

      try {
        fixRequestBody(proxyReq, req);
      } catch (_) {}

      const rid = req.headers["x-request-id"];
      if (rid) {
        try {
          proxyReq.setHeader("X-Request-Id", rid);
        } catch (_) {}
      }

      if (req.headers.authorization) {
        try {
          proxyReq.setHeader("Authorization", req.headers.authorization);
        } catch (_) {}
      }

      if (config.principalInternalToken) {
        try {
          proxyReq.setHeader(
            "x-internal-token",
            String(config.principalInternalToken)
          );
        } catch (_) {}
      }

      try {
        proxyReq.setHeader("x-forwarded-service", "api-gateway");
      } catch (_) {}
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      const status = proxyRes.statusCode || 502;
      const ct = String(proxyRes.headers["content-type"] || "");

      if (status === 429 && ct.includes("text/html")) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return JSON.stringify({
          success: false,
          error: "UPSTREAM_RATE_LIMITED",
          message:
            "Le service principal a rejeté la requête (429). Cause probable: protection/anti-bot sur l'URL publique. Solution: utiliser l'Internal URL Render pour PRINCIPAL_URL.",
          path: req.originalUrl,
        });
      }

      if (status === 403 && ct.includes("text/html")) {
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
    }),

    onError: (err, req, res) => {
      logger.error("[PROXY principal] error", {
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

const principalProxy = makePrincipalProxy();

// ─────────── AUTH GLOBAL GATEWAY ───────────
const openEndpoints = [
  "/",
  "/api/v1",
  "/healthz",
  "/status",
  "/docs",
  "/openapi.json",

  "/api/v1/auth",
  "/api/v1/verification",

  "/api/v1/public",

  "/api/v1/fees/simulate",
  "/api/v1/commissions/simulate",
  "/api/v1/exchange-rates/rate",

  "/internal/transactions",
  "/api/v1/internal",

  "/api/v1/transactions/internal",

  "/api/v1/jobs",
  "/api/v1/contact",
  "/api/v1/reports",
  "/api/v1/feedback/threads",
];

app.use((req, res, next) => {
  const isOpen = openEndpoints.some(
    (ep) => req.path === ep || req.path.startsWith(ep + "/")
  );
  if (isOpen) return next();
  return authMiddleware(req, res, next);
});

// ─────────── /public : signature HMAC obligatoire ───────────
app.use("/api/v1/public", (req, res, next) => {
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

// audit headers après auth
app.use(auditHeaders);

// ✅ Limiteur spécial /users/me
app.use("/api/v1/users/me", (req, res, next) => meLimiter(req, res, next));

// ✅ user limiter global
app.use((req, res, next) => userLimiter(req, res, next));

// ─────────── DB READY STATE ───────────
const mongoRequiredPrefixes = [
  "/api/v1/admin",
  "/api/v1/aml",
  "/api/v1/fees",
  "/api/v1/commissions",
  "/api/v1/exchange-rates",
  "/api/v1/pricing",
  "/api/v1/fx-rules",
  "/api/v1/phone-verification",
];

app.use((req, res, next) => {
  const needsMongo = mongoRequiredPrefixes.some(
    (p) => req.path === p || req.path.startsWith(p + "/")
  );

  if (!needsMongo) return next();

  if (mongoose.connection.readyState !== 1) {
    logger.error("[MONGO] Requête refusée, MongoDB non connecté !");
    return res.status(500).json({
      success: false,
      error: "MongoDB non connecté",
    });
  }

  return next();
});

// ─────────── ROUTES GATEWAY NATIVES ───────────
app.use("/api/v1/pay", paymentRoutes);
app.use("/internal/transactions", internalTransactionsRouter);
app.use("/api/v1/internal", internalRoutes);
app.use("/api/v1/transactions", userTransactionRoutes);
app.use("/api/v1/admin/transactions", transactionRoutes);
app.use("/api/v1/aml", amlRoutes);
app.use("/api/v1/fees", feesRoutes);
app.use("/api/v1/exchange-rates", exchangeRateRoutes);
app.use("/api/v1/commissions", commissionsRoutes);
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/fx-rules", fxRulesRoutes);
app.use("/api/v1/phone-verification", phoneVerificationRoutes);

// ✅ PROXY FINAL: routes du backend principal
if (principalProxy) {
  const uniq = Array.from(new Set(PRINCIPAL_PREFIXES));
  uniq.forEach((prefix) => app.use(prefix, principalProxy));
}

// 404
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Ressource non trouvée" })
);

// error handler
app.use((err, req, res, _next) => {
  logger.error("[API ERROR]", {
    message: err.message,
    stack: err.stack,
    status: err.status,
    path: req.originalUrl,
    method: req.method,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
    user: req.user?.email,
    body: req.body,
  });

  setCorsHeaders(req, res);

  res.status(err.status || 500).json({
    success: false,
    error:
      err.isJoi && err.details
        ? err.details.map((d) => d.message).join("; ")
        : err.message || "Erreur serveur",
  });
});

module.exports = app;