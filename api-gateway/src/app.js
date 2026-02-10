// File: api-gateway/src/app.js
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
const { createProxyMiddleware, fixRequestBody } = require("http-proxy-middleware");

// ✅ Config (DOIT être chargé AVANT d'utiliser config.*)
const config = require("./config");

// ✅ Swagger (docs Gateway)
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const path = require("path");
const openapiSpec = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

// ✅ Middlewares internes
const { authMiddleware } = require("./middlewares/auth");
const { globalIpLimiter, userLimiter } = require("./middlewares/rateLimit");
const { loggerMiddleware } = require("./middlewares/logger");
const auditHeaders = require("./middlewares/auditHeaders");
const logger = require("./logger");
const { getAllProviders, getProvider } = require("./providers");

// ✅ Routes (gateway natives)
const paymentRoutes = require("../routes/payment");
const amlRoutes = require("../routes/aml");
const transactionRoutes = require("../routes/admin/transactions.admin.routes");
const feesRoutes = require("../routes/fees");
const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
const commissionsRoutes = require("../routes/commissionsRoutes");
const userTransactionRoutes = require("../routes/transactions");

// legacy internal
const internalTransactionsRouter = require("../routes/internalTransactions");
const internalRoutes = require("../routes/internalRoutes");

// phone verification
const phoneVerificationRoutes = require("../routes/phoneVerificationRoutes");

// pricing + fx rules
const pricingRoutes = require("../routes/pricingRoutes");
const fxRulesRoutes = require("../routes/fxRules");

// public read-only (HMAC signed)
const publicRoutes = require("../routes/publicRoutes");
const requirePublicSignature = require("./middlewares/requirePublicSignature");

const app = express();

// Logs
try {
  logger.info?.("[BOOT] env=" + (config.nodeEnv || process.env.NODE_ENV));
  logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
  logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
} catch (_) {}

app.set("trust proxy", 1);

// ─────────────────────────────────────────────────────────────
// ✅ CORS DOIT ÊTRE TOUT EN HAUT (avant rate-limit et avant routes)
// ─────────────────────────────────────────────────────────────
function buildAllowedOriginsSet() {
  const set = new Set();
  (config.cors?.origins || []).forEach((o) => set.add(o));
  (config.cors?.adminOrigins || []).forEach((o) => set.add(o));
  (config.cors?.mobileOrigins || []).forEach((o) => set.add(o));
  return set;
}

const allowedOrigins = buildAllowedOriginsSet();
const allowAll =
  allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

// ✅ fallback DEV: autorise localhost si pas configuré
const nodeEnv = config.nodeEnv || process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";
const devLocalOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const corsOptions = {
  origin: (origin, cb) => {
    // outils/SSR/Postman
    if (!origin) return cb(null, true);

    if (allowAll) return cb(null, true);

    // ✅ autoriser localhost en dev même si config pas prêt
    if (!isProd && devLocalOrigins.has(origin)) return cb(null, true);

    if (allowedOrigins.has(origin)) return cb(null, true);

    // Important: renvoyer false => pas de header CORS
    // (et le navigateur bloquera). En prod c’est voulu.
    return cb(null, false);
  },
  credentials: config.cors?.allowCredentials !== false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Request-Id"],
  exposedHeaders: ["Retry-After"], // utile pour 429 côté front
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

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

// IMPORTANT: body parser AVANT proxy (fixRequestBody gère l’envoi)
app.use(express.json({ limit: "2mb" }));
app.use(loggerMiddleware);

// 🛡️ Bouclier global IP
// ✅ on skip OPTIONS sinon ça peut générer des CORS faux-positifs
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return globalIpLimiter(req, res, next);
});

// ─────────── RATE LIMIT spécial /public (read-only) ───────────
if (config.rateLimit?.public) {
  const publicLimiter = rateLimit({
    windowMs: config.rateLimit.public.windowMs,
    max: config.rateLimit.public.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    handler: (req, res) => {
      // CORS headers déjà posés car cors() est au-dessus
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
  res.setHeader("Cache-Control", "no-store");
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
// ✅ PROXY vers BACKEND PRINCIPAL (pour routes app)
// ─────────────────────────────────────────────────────────────
const PRINCIPAL_BASE = config.principalUrl || process.env.PRINCIPAL_API_BASE_URL || "";

// Préfixes servis par le backend principal (proxy)
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
  "/api/v1/moderation",
  "/api/v1/announcements",
  "/api/v1/upload",
  "/api/v1/rates",
];

// Factory proxy vers principal
function makePrincipalProxy() {
  if (!PRINCIPAL_BASE) {
    logger.warn?.("[PROXY] PRINCIPAL_BASE missing -> principal routes disabled");
    return null;
  }

  return createProxyMiddleware({
    target: PRINCIPAL_BASE,
    changeOrigin: true,
    xfwd: true,
    ws: true,
    logLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
    proxyTimeout: 30000,
    timeout: 30000,

    onProxyReq: (proxyReq, req) => {
      fixRequestBody(proxyReq, req);

      const rid = req.headers["x-request-id"];
      if (rid) proxyReq.setHeader("X-Request-Id", rid);

      if (req.headers.authorization)
        proxyReq.setHeader("Authorization", req.headers.authorization);

      if (config.principalInternalToken) {
        proxyReq.setHeader("x-internal-token", String(config.principalInternalToken));
      }

      proxyReq.setHeader("x-forwarded-service", "api-gateway");
    },

    onError: (err, req, res) => {
      logger.error("[PROXY principal] error", { message: err.message, path: req.originalUrl });
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: "Principal upstream unavailable" });
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

  // auth du principal (proxy) => ouvert
  "/api/v1/auth",
  "/api/v1/verification",

  // public HMAC signed
  "/api/v1/public",

  // legacy simulate endpoints (gateway)
  "/api/v1/fees/simulate",
  "/api/v1/commissions/simulate",

  // legacy FX public rate
  "/api/v1/exchange-rates/rate",

  // internal routes (protégées dans leurs routes)
  "/internal/transactions",
  "/api/v1/internal",
];

app.use((req, res, next) => {
  // ✅ préflight déjà géré plus haut, mais on garde une sécurité
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const isOpen = openEndpoints.some(
    (ep) => req.path === ep || req.path.startsWith(ep + "/")
  );
  if (isOpen) return next();

  return authMiddleware(req, res, next);
});

// ─────────── /public/* : signature HMAC obligatoire ───────────
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

// ✅ Mount read-only public routes
app.use("/api/v1/public", publicRoutes);

// Ajout headers audit après auth (req.user si JWT ok)
app.use(auditHeaders);

// ✅ Rate limit par utilisateur (protégé) MAIS on évite de casser /users/me
// Sinon ton front appelle /users/me plusieurs fois (layout, guards, refresh token) -> 429
app.use((req, res, next) => {
  const isUsersMe =
    req.method === "GET" &&
    (req.path === "/api/v1/users/me" || req.path.startsWith("/api/v1/users/me/"));
  if (isUsersMe) return next();
  return userLimiter(req, res, next);
});

/**
 * ─────────── DB READY STATE (bloque UNIQUEMENT les routes DB du GATEWAY) ───────────
 * Objectif: la gateway doit pouvoir proxy /auth, /users... même si Mongo du gateway est KO.
 */
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
    logger.error("[MONGO] Requête refusée (route DB gateway), MongoDB non connecté !");
    return res.status(500).json({ success: false, error: "MongoDB non connecté" });
  }
  return next();
});

// ─────────── ROUTES GATEWAY NATIVES ───────────

// payment
app.use("/api/v1/pay", paymentRoutes);

// legacy internal
app.use("/internal/transactions", internalTransactionsRouter);

// nouvelles routes internes versionnées
app.use("/api/v1/internal", internalRoutes);

// tx (gateway -> tx-core microservice)
app.use("/api/v1/transactions", userTransactionRoutes);

// admins
app.use("/api/v1/admin/transactions", transactionRoutes);

// db-ish routes
app.use("/api/v1/aml", amlRoutes);
app.use("/api/v1/fees", feesRoutes);
app.use("/api/v1/exchange-rates", exchangeRateRoutes);
app.use("/api/v1/commissions", commissionsRoutes);

// pricing + fx rules
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/fx-rules", fxRulesRoutes);

// phone verification
app.use("/api/v1/phone-verification", phoneVerificationRoutes);

// ─────────────────────────────────────────────────────────────
// ✅ PROXY FINAL: routes du backend principal passent ICI
// ─────────────────────────────────────────────────────────────
if (principalProxy) {
  PRINCIPAL_PREFIXES.forEach((prefix) => {
    app.use(prefix, principalProxy);
  });
}

// ─────────── 404 & ERROR HANDLERS ───────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Ressource non trouvée" })
);

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

  res.status(err.status || 500).json({
    success: false,
    error:
      err.isJoi && err.details
        ? err.details.map((d) => d.message).join("; ")
        : err.message || "Erreur serveur",
  });
});

module.exports = app;
