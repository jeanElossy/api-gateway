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

// const config = require("./config");
// const swaggerUi = require("swagger-ui-express");
// const YAML = require("yamljs");
// const path = require("path");
// const openapiSpec = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

// const { authMiddleware } = require("./middlewares/auth");
// const {
//   globalIpLimiter,
//   authLoginLimiter,
//   meLimiter,
//   announcementsLimiter,
//   adminTransactionsLimiter,
//   userLimiter,
// } = require("./middlewares/rateLimit");
// const { loggerMiddleware } = require("./middlewares/logger");
// const auditHeaders = require("./middlewares/auditHeaders");
// const logger = require("./logger");
// const { getAllProviders, getProvider } = require("./providers");

// const paymentRoutes = require("../routes/payment");
// const amlRoutes = require("../routes/aml");
// const transactionRoutes = require("../routes/admin/transactions.admin.routes");
// const feesRoutes = require("../routes/fees");
// const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
// const commissionsRoutes = require("../routes/commissionsRoutes");
// const userTransactionRoutes = require("../routes/transactions");

// const internalTransactionsRouter = require("../routes/internalTransactions");
// const internalRoutes = require("../routes/internalRoutes");
// const pricingRoutes = require("../routes/pricingRoutes");
// const fxRulesRoutes = require("../routes/fxRules");
// const publicRoutes = require("../routes/publicRoutes");
// const requirePublicSignature = require("./middlewares/requirePublicSignature");
// const pricingRulesRoutes = require("../routes/pricingRulesRoutes");
// const providerWebhooksRoutes = require("../routes/providerWebhookRoutes");

// const app = express();

// try {
//   logger.info?.("[BOOT] env=" + (config.nodeEnv || process.env.NODE_ENV));
//   logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
//   logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
//   logger.info?.("[BOOT] PRINCIPAL_URL=" + String(config.principalUrl || ""));
// } catch {}

// /**
//  * IMPORTANT:
//  * 1 = un proxy de confiance devant la gateway
//  * évite ERR_ERL_PERMISSIVE_TRUST_PROXY avec express-rate-limit
//  */
// app.set("trust proxy", 1);

// /* -------------------------------------------------------------------------- */
// /* CORS                                                                       */
// /* -------------------------------------------------------------------------- */

// function buildAllowedOriginsSet() {
//   const set = new Set();

//   (config.cors?.origins || []).forEach((o) => o && set.add(o));
//   (config.cors?.adminOrigins || []).forEach((o) => o && set.add(o));
//   (config.cors?.mobileOrigins || []).forEach((o) => o && set.add(o));

//   [
//     "http://localhost:3000",
//     "http://127.0.0.1:3000",
//     "http://localhost:5173",
//     "http://127.0.0.1:5173",
//   ].forEach((o) => set.add(o));

//   return set;
// }

// const allowedOrigins = buildAllowedOriginsSet();
// const allowAll =
//   allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

// function isOriginAllowed(origin) {
//   if (!origin) return true;
//   if (allowAll) return true;
//   return allowedOrigins.has(origin);
// }

// const ALLOWED_HEADERS = [
//   "Content-Type",
//   "Authorization",
//   "X-Requested-With",
//   "X-Request-Id",
//   "x-request-id",
//   "x-internal-token",
//   "Cache-Control",
//   "Pragma",
//   "Expires",
//   "Accept",
//   "Origin",
//   "stripe-signature",
//   "x-signature",
//   "x-paynoval-signature",
//   "X-Analytics-Key",
//   "x-analytics-key",
//   "X-Visitor-Id",
//   "x-visitor-id",
//   "X-Session-Id",
//   "x-session-id",
// ];

// const EXPOSED_HEADERS = [
//   "Retry-After",
//   "X-RateLimit-Limit",
//   "X-RateLimit-Remaining",
//   "X-Request-Id",
// ];

// const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// function setCorsHeaders(req, res) {
//   const origin = req.headers.origin;

//   if (origin && isOriginAllowed(origin)) {
//     res.setHeader("Access-Control-Allow-Origin", origin);
//     res.setHeader("Vary", "Origin");

//     if (config.cors?.allowCredentials !== false) {
//       res.setHeader("Access-Control-Allow-Credentials", "true");
//     }

//     res.setHeader("Access-Control-Allow-Methods", CORS_METHODS.join(","));
//     res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
//     res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS.join(", "));
//     res.setHeader("Access-Control-Max-Age", "86400");
//   }
// }

// app.use((req, res, next) => {
//   setCorsHeaders(req, res);

//   if (req.method === "OPTIONS") {
//     return res.sendStatus(204);
//   }

//   next();
// });

// app.use(
//   cors({
//     origin: (origin, cb) => {
//       if (!origin) return cb(null, true);
//       if (isOriginAllowed(origin)) return cb(null, true);
//       return cb(new Error(`CORS blocked for origin: ${origin}`));
//     },
//     credentials: config.cors?.allowCredentials !== false,
//     methods: CORS_METHODS,
//     allowedHeaders: ALLOWED_HEADERS,
//     exposedHeaders: EXPOSED_HEADERS,
//     maxAge: 86400,
//     optionsSuccessStatus: 204,
//   })
// );

// /* -------------------------------------------------------------------------- */
// /* Security / parsing / logging                                               */
// /* -------------------------------------------------------------------------- */

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
//       "siteId",
//       "groupBy",
//     ],
//   })
// );

// if (config.nodeEnv !== "test") {
//   app.use(morgan(config.logging?.level === "debug" ? "dev" : "combined"));
// }

// app.use(express.json({ limit: "2mb" }));
// app.use(express.urlencoded({ extended: true, limit: "2mb" }));
// app.use(loggerMiddleware);

// /* -------------------------------------------------------------------------- */
// /* Rate limits spécifiques                                                    */
// /* -------------------------------------------------------------------------- */

// app.use("/api/v1/auth/login", authLoginLimiter);
// app.use("/api/v1/auth/login-2fa", authLoginLimiter);
// app.use("/api/v1/announcements", announcementsLimiter);

// app.use("/api/v1", (req, res, next) => {
//   res.setHeader(
//     "Cache-Control",
//     "no-store, no-cache, must-revalidate, proxy-revalidate"
//   );
//   res.setHeader("Pragma", "no-cache");
//   res.setHeader("Expires", "0");
//   next();
// });

// /* -------------------------------------------------------------------------- */
// /* Helpers                                                                    */
// /* -------------------------------------------------------------------------- */

// function isSocketIoRequest(req) {
//   return req.path === "/socket.io" || req.path.startsWith("/socket.io/");
// }

// function isPrivilegedRole(req) {
//   const role = String(req?.user?.role || "").toLowerCase();
//   return ["admin", "superadmin", "support"].includes(role);
// }

// /* -------------------------------------------------------------------------- */
// /* Global IP limiter                                                          */
// /* -------------------------------------------------------------------------- */

// app.use((req, res, next) => {
//   if (req.method === "OPTIONS") return next();
//   if (isSocketIoRequest(req)) return next();
//   return globalIpLimiter(req, res, next);
// });

// /* -------------------------------------------------------------------------- */
// /* Public read-only limiter                                                   */
// /* -------------------------------------------------------------------------- */

// if (config.rateLimit?.public) {
//   const publicLimiter = rateLimit({
//     windowMs: config.rateLimit.public.windowMs,
//     max: config.rateLimit.public.max,
//     standardHeaders: true,
//     legacyHeaders: false,
//     skip: (req) => req.method === "OPTIONS",
//     handler: (req, res) => {
//       setCorsHeaders(req, res);
//       res.status(429).json({
//         success: false,
//         message: "Trop de requêtes (public). Réessaie dans un instant.",
//       });
//     },
//   });

//   app.use("/api/v1/public", publicLimiter);
// }

// /* -------------------------------------------------------------------------- */
// /* Docs / health                                                              */
// /* -------------------------------------------------------------------------- */

// app.get("/openapi.json", (_req, res) => res.json(openapiSpec));
// app.use(
//   "/docs",
//   swaggerUi.serve,
//   swaggerUi.setup(openapiSpec, {
//     explorer: true,
//     customSiteTitle: "PayNoval Gateway API",
//   })
// );

// app.get("/", (_req, res) =>
//   res.json({
//     status: "ok",
//     service: "api-gateway",
//     ts: new Date().toISOString(),
//   })
// );

// app.get("/api/v1", (_req, res) => {
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

// /* -------------------------------------------------------------------------- */
// /* Proxy backend principal                                                    */
// /* -------------------------------------------------------------------------- */

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
//   "/api/v1/kyb",
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
//   "/api/v1/referrals",
//   "/api/v1/internal/referrals",
//   "/api/v1/internal/referral",
//   "/api/v1/fx",
//   "/api/v1/analytics",
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
//     secure: !isHttp,
//     selfHandleResponse: true,

//     pathRewrite: (pathReq) => {
//       if (pathReq.startsWith("/api/v1/analytics")) {
//         return pathReq.replace(/^\/api\/v1\/analytics/, "/analytics");
//       }
//       return pathReq;
//     },

//     onProxyReq: (proxyReq, req, res) => {
//       if (res?.headersSent || res?.writableEnded) return;

//       try {
//         fixRequestBody(proxyReq, req);
//       } catch {}

//       const rid = req.headers["x-request-id"];
//       if (rid) {
//         try {
//           proxyReq.setHeader("X-Request-Id", rid);
//         } catch {}
//       }

//       if (req.headers.authorization) {
//         try {
//           proxyReq.setHeader("Authorization", req.headers.authorization);
//         } catch {}
//       }

//       if (req.headers["x-analytics-key"]) {
//         try {
//           proxyReq.setHeader("x-analytics-key", req.headers["x-analytics-key"]);
//         } catch {}
//       }

//       if (req.headers["x-visitor-id"]) {
//         try {
//           proxyReq.setHeader("x-visitor-id", req.headers["x-visitor-id"]);
//         } catch {}
//       }

//       if (req.headers["x-session-id"]) {
//         try {
//           proxyReq.setHeader("x-session-id", req.headers["x-session-id"]);
//         } catch {}
//       }

//       if (config.principalInternalToken) {
//         try {
//           proxyReq.setHeader(
//             "x-internal-token",
//             String(config.principalInternalToken)
//           );
//         } catch {}
//       }

//       try {
//         proxyReq.setHeader("x-forwarded-service", "api-gateway");
//       } catch {}
//     },

//     onProxyRes: responseInterceptor(
//       async (responseBuffer, proxyRes, req, res) => {
//         const status = proxyRes.statusCode || 502;
//         const ct = String(proxyRes.headers["content-type"] || "");

//         if (status === 429 && ct.includes("text/html")) {
//           res.setHeader("Content-Type", "application/json; charset=utf-8");
//           return JSON.stringify({
//             success: false,
//             error: "UPSTREAM_RATE_LIMITED",
//             message:
//               "Le service principal a rejeté la requête (429). Cause probable: protection/anti-bot sur l'URL publique. Solution: utiliser l'Internal URL Render pour PRINCIPAL_URL.",
//             path: req.originalUrl,
//           });
//         }

//         if (status === 403 && ct.includes("text/html")) {
//           res.setHeader("Content-Type", "application/json; charset=utf-8");
//           return JSON.stringify({
//             success: false,
//             error: "UPSTREAM_FORBIDDEN",
//             message:
//               "Le service principal a renvoyé un challenge/protection (403). Utilise l'Internal URL Render pour PRINCIPAL_URL.",
//             path: req.originalUrl,
//           });
//         }

//         return responseBuffer;
//       }
//     ),

//     onError: (err, req, res) => {
//       logger.error("[PROXY principal] error", {
//         message: err.message,
//         path: req.originalUrl,
//       });

//       if (!res.headersSent) {
//         setCorsHeaders(req, res);
//         res.status(502).json({
//           success: false,
//           error: "Principal upstream unavailable",
//         });
//       }
//     },
//   });
// }

// function makePrincipalSocketProxy() {
//   if (!PRINCIPAL_BASE) {
//     logger.warn?.("[SOCKET PROXY] PRINCIPAL_BASE missing -> socket proxy disabled");
//     return null;
//   }

//   const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

//   return createProxyMiddleware({
//     target: PRINCIPAL_BASE,
//     changeOrigin: true,
//     xfwd: true,
//     ws: true,
//     secure: !isHttp,
//     logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
//     proxyTimeout: 30000,
//     timeout: 30000,
//     onProxyReqWs: (proxyReq, req) => {
//       try {
//         const rid = req.headers["x-request-id"];
//         if (rid) proxyReq.setHeader("X-Request-Id", rid);

//         if (config.principalInternalToken) {
//           proxyReq.setHeader(
//             "x-internal-token",
//             String(config.principalInternalToken)
//           );
//         }

//         proxyReq.setHeader("x-forwarded-service", "api-gateway");
//       } catch {}
//     },
//     onError: (err, req, res) => {
//       logger.error("[SOCKET PROXY] error", {
//         message: err.message,
//         path: req.originalUrl,
//       });

//       if (res && !res.headersSent) {
//         setCorsHeaders(req, res);
//         res.status(502).json({
//           success: false,
//           error: "Principal socket upstream unavailable",
//         });
//       }
//     },
//   });
// }

// const principalProxy = makePrincipalProxy();
// const principalSocketProxy = makePrincipalSocketProxy();

// if (principalSocketProxy) {
//   app.use("/socket.io", principalSocketProxy);
// }

// /* -------------------------------------------------------------------------- */
// /* Auth global                                                                */
// /* -------------------------------------------------------------------------- */

// const openEndpoints = [
//   "/",
//   "/api/v1",
//   "/healthz",
//   "/status",
//   "/docs",
//   "/openapi.json",
//   "/socket.io",
//   "/api/v1/auth",
//   "/api/v1/verification",
//   "/api/v1/public",
//   "/api/v1/fees/simulate",
//   "/api/v1/commissions/simulate",
//   "/api/v1/exchange-rates/rate",
//   "/api/v1/pricing",
//   "/internal/transactions",
//   "/api/v1/internal",
//   "/api/v1/transactions/internal",
//   "/api/v1/jobs",
//   "/api/v1/contact",
//   "/api/v1/reports",
//   "/api/v1/feedback/threads",
//   "/api/v1/provider-webhooks",
//   "/api/v1/analytics",
// ];

// app.use((req, res, next) => {
//   const isOpen = openEndpoints.some(
//     (ep) => req.path === ep || req.path.startsWith(ep + "/")
//   );
//   if (isOpen) return next();
//   return authMiddleware(req, res, next);
// });

// /* -------------------------------------------------------------------------- */
// /* Public signed routes                                                       */
// /* -------------------------------------------------------------------------- */

// app.use("/api/v1/public", (req, res, next) => {
//   const openPublicFx = req.path === "/fx/latest" || req.path === "/fx/history";

//   if (openPublicFx) {
//     return next();
//   }

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

// /* -------------------------------------------------------------------------- */
// /* Post-auth middleware                                                       */
// /* -------------------------------------------------------------------------- */

// app.use(auditHeaders);

// app.use("/api/v1/users/me", (req, res, next) => {
//   if (isPrivilegedRole(req)) return next();
//   return meLimiter(req, res, next);
// });

// app.use((req, res, next) => {
//   if (isSocketIoRequest(req)) return next();
//   if (isPrivilegedRole(req)) return next();

//   if (
//     req.path === "/api/v1/provider-webhooks" ||
//     req.path.startsWith("/api/v1/provider-webhooks/")
//   ) {
//     return next();
//   }

//   return userLimiter(req, res, next);
// });

// /* -------------------------------------------------------------------------- */
// /* Mongo readiness for selected routes                                        */
// /* -------------------------------------------------------------------------- */

// const mongoRequiredPrefixes = [
//   "/api/v1/admin",
//   "/api/v1/aml",
//   "/api/v1/fees",
//   "/api/v1/commissions",
//   "/api/v1/exchange-rates",
//   "/api/v1/pricing",
//   "/api/v1/fx-rules",
// ];

// app.use((req, res, next) => {
//   const needsMongo = mongoRequiredPrefixes.some(
//     (p) => req.path === p || req.path.startsWith(p + "/")
//   );

//   if (!needsMongo) return next();

//   if (mongoose.connection.readyState !== 1) {
//     logger.error("[MONGO] Requête refusée, MongoDB non connecté !");
//     return res.status(500).json({
//       success: false,
//       error: "MongoDB non connecté",
//     });
//   }

//   return next();
// });

// /* -------------------------------------------------------------------------- */
// /* Native gateway routes                                                      */
// /* -------------------------------------------------------------------------- */

// app.use("/api/v1/provider-webhooks", providerWebhooksRoutes);

// app.use("/api/v1/pay", paymentRoutes);
// app.use("/internal/transactions", internalTransactionsRouter);
// app.use("/api/v1/internal", internalRoutes);
// app.use("/api/v1/transactions", userTransactionRoutes);

// app.use(
//   "/api/v1/admin/transactions",
//   adminTransactionsLimiter,
//   transactionRoutes
// );

// app.use("/api/v1/aml", amlRoutes);
// app.use("/api/v1/fees", feesRoutes);
// app.use("/api/v1/exchange-rates", exchangeRateRoutes);
// app.use("/api/v1/commissions", commissionsRoutes);
// app.use("/api/v1/pricing", pricingRoutes);
// app.use("/api/v1/fx-rules", fxRulesRoutes);
// app.use("/api/v1/pricing-rules", pricingRulesRoutes);

// /* -------------------------------------------------------------------------- */
// /* Final proxy to principal backend                                           */
// /* -------------------------------------------------------------------------- */

// if (principalProxy) {
//   const uniq = Array.from(new Set(PRINCIPAL_PREFIXES));
//   uniq.forEach((prefix) => app.use(prefix, principalProxy));
// }

// /* -------------------------------------------------------------------------- */
// /* 404                                                                        */
// /* -------------------------------------------------------------------------- */

// app.use((req, res) =>
//   res.status(404).json({ success: false, error: "Ressource non trouvée" })
// );

// /* -------------------------------------------------------------------------- */
// /* Error handler                                                              */
// /* -------------------------------------------------------------------------- */

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

//   setCorsHeaders(req, res);

//   res.status(err.status || 500).json({
//     success: false,
//     error:
//       err.isJoi && err.details
//         ? err.details.map((d) => d.message).join("; ")
//         : err.message || "Erreur serveur",
//   });
// });

// module.exports = app;








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
  adminTransactionsLimiter,
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
const commissionsRoutes = require("../routes/commissionsRoutes");
const userTransactionRoutes = require("../routes/transactions");

const internalTransactionsRouter = require("../routes/internalTransactions");
const internalRoutes = require("../routes/internalRoutes");
const pricingRoutes = require("../routes/pricingRoutes");
const fxRulesRoutes = require("../routes/fxRules");
const publicRoutes = require("../routes/publicRoutes");
const requirePublicSignature = require("./middlewares/requirePublicSignature");
const pricingRulesRoutes = require("../routes/pricingRulesRoutes");
const providerWebhooksRoutes = require("../routes/providerWebhookRoutes");

const app = express();

try {
  logger.info?.("[BOOT] env=" + (config.nodeEnv || process.env.NODE_ENV));
  logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
  logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
  logger.info?.("[BOOT] PRINCIPAL_URL=" + String(config.principalUrl || ""));
} catch {}

/**
 * 1 = un proxy de confiance devant la gateway.
 */
app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

function buildAllowedOriginsSet() {
  const set = new Set();

  (config.cors?.origins || []).forEach((origin) => origin && set.add(origin));
  (config.cors?.adminOrigins || []).forEach((origin) => origin && set.add(origin));
  (config.cors?.mobileOrigins || []).forEach((origin) => origin && set.add(origin));

  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].forEach((origin) => set.add(origin));

  return set;
}

const allowedOrigins = buildAllowedOriginsSet();
const allowAll =
  allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowAll) return true;
  return allowedOrigins.has(origin);
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

  next();
});

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

/* -------------------------------------------------------------------------- */
/* Security / parsing / logging                                               */
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
    ],
  })
);

if (config.nodeEnv !== "test") {
  app.use(morgan(config.logging?.level === "debug" ? "dev" : "combined"));
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(loggerMiddleware);

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
        const health = await axios.get(provider.url + (provider.health || "/health"), {
          timeout: 3000,
        });

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
   * Toutes les routes admin, y compris :
   * /api/v1/admin/transactions/:id/cancel-refund
   * vont maintenant vers le backend principal.
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

function makePrincipalSocketProxy() {
  if (!PRINCIPAL_BASE) {
    logger.warn?.("[SOCKET PROXY] PRINCIPAL_BASE missing -> socket proxy disabled");
    return null;
  }

  const isHttp = /^http:\/\//i.test(PRINCIPAL_BASE);

  return createProxyMiddleware({
    target: PRINCIPAL_BASE,
    changeOrigin: true,
    xfwd: true,
    ws: true,
    secure: !isHttp,
    logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
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
      logger.error("[SOCKET PROXY] error", {
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

const openEndpoints = [
  "/",
  "/api/v1",
  "/healthz",
  "/status",
  "/docs",
  "/openapi.json",
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

app.use((req, res, next) => {
  const isOpen = openEndpoints.some(
    (endpoint) => req.path === endpoint || req.path.startsWith(endpoint + "/")
  );

  if (isOpen) return next();

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
];

app.use((req, res, next) => {
  const needsMongo = mongoRequiredPrefixes.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + "/")
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

app.use("/api/v1/aml", amlRoutes);
app.use("/api/v1/fees", feesRoutes);
app.use("/api/v1/exchange-rates", exchangeRateRoutes);
app.use("/api/v1/commissions", commissionsRoutes);
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/fx-rules", fxRulesRoutes);
app.use("/api/v1/pricing-rules", pricingRulesRoutes);

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
        ? err.details.map((detail) => detail.message).join("; ")
        : err.message || "Erreur serveur",
  });
});

module.exports = app;