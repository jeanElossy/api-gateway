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

// ✅ Config (DOIT être chargé AVANT d'utiliser config.*)
const config = require("./config");

// ✅ Swagger (docs Gateway)
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const path = require("path");
const openapiSpec = YAML.load(path.join(__dirname, "../docs/openapi.yaml"));

// Routes
const paymentRoutes = require("../routes/payment");
const amlRoutes = require("../routes/aml");
const transactionRoutes = require("../routes/admin/transactions.admin.routes");
const feesRoutes = require("../routes/fees");
const exchangeRateRoutes = require("../routes/admin/exchangeRates.routes");
const commissionsRoutes = require("../routes/commissionsRoutes");
const userTransactionRoutes = require("../routes/transactions");

// 🔧 Route interne existante (legacy)
const internalTransactionsRouter = require("../routes/internalTransactions");
// 🔧 Nouvelles routes internes versionnées
const internalRoutes = require("../routes/internalRoutes");

// ✅ Phone verification
const phoneVerificationRoutes = require("../routes/phoneVerificationRoutes");

// ✅ Pricing + FX rules
const pricingRoutes = require("../routes/pricingRoutes");
const fxRulesRoutes = require("../routes/fxRules");

// ✅ Public read-only routes
const publicRoutes = require("../routes/publicRoutes");

const { authMiddleware } = require("./middlewares/auth");
const { globalIpLimiter, userLimiter } = require("./middlewares/rateLimit");
const { loggerMiddleware } = require("./middlewares/logger");
const auditHeaders = require("./middlewares/auditHeaders");
const logger = require("./logger");
const { getAllProviders, getProvider } = require("./providers");

const app = express();

// Logs (APRÈS init config)
try {
  logger.info?.("[BOOT] env=" + config.env);
  logger.info?.("[BOOT] HMAC enabled=" + String(!!config.publicReadonlySecret));
  logger.info?.("[BOOT] HMAC TTL=" + String(config.publicSignatureTtlSec));
} catch (_) {
  // no-op
}

// 🔐 important derrière Render / Cloudflare
app.set("trust proxy", 1);

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
    whitelist: ["page", "limit", "sort", "provider", "status"],
  })
);

// ─────────── CORS (compat + moderne) ───────────
function buildAllowedOriginsSet() {
  const set = new Set();

  // legacy config.cors.origins (si présent)
  (config.cors?.origins || []).forEach((o) => set.add(o));

  // nouveaux allowlists
  (config.cors?.adminOrigins || []).forEach((o) => set.add(o));
  (config.cors?.mobileOrigins || []).forEach((o) => set.add(o));

  return set;
}

const allowedOrigins = buildAllowedOriginsSet();
const allowAll = allowedOrigins.has("*") || (config.cors?.origins || []).includes("*");

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // mobile native / postman / curl
      if (allowAll) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("CORS: origine non autorisée"));
    },
    credentials: config.cors?.allowCredentials !== false,
  })
);

if (config.nodeEnv !== "test") {
  app.use(morgan(config.logging.level === "debug" ? "dev" : "combined"));
}

app.use(express.json({ limit: "2mb" }));
app.use(loggerMiddleware);

// 🛡️ Bouclier global IP (avant tout)
app.use(globalIpLimiter);

// ─────────── RATE LIMIT spécial /public (read-only) ───────────
let rateLimit = null;
try {
  rateLimit = require("express-rate-limit");
} catch (e) {
  rateLimit = null;
}

if (rateLimit && config.rateLimit?.public) {
  const publicLimiter = rateLimit({
    windowMs: config.rateLimit.public.windowMs,
    max: config.rateLimit.public.max,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/v1/public", publicLimiter);
}

// ─────────── DOCS PUBLIQUES ───────────
app.get("/openapi.json", (_req, res) => res.json(openapiSpec));
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: "PayNoval Gateway API",
  })
);

// ─────────── HEALTH / STATUS (avant Mongo guard) ───────────
app.get("/", (_req, res) =>
  res.json({
    status: "ok",
    service: "api-gateway",
    ts: new Date().toISOString(),
  })
);

app.get("/healthz", (_req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/status", async (_req, res) => {
  const statuses = {};
  await Promise.all(
    getAllProviders().map(async (name) => {
      const p = getProvider(name);
      if (!p || !p.enabled) return;
      try {
        const health = await axios.get(p.url + (p.health || "/health"), { timeout: 3000 });
        statuses[name] = { up: true, status: health.data.status || "ok" };
      } catch (err) {
        statuses[name] = { up: false, error: err.message };
      }
    })
  );
  res.json({ gateway: "ok", microservices: statuses });
});

// ─────────── AUTH GLOBAL GATEWAY ───────────
const openEndpoints = [
  "/",
  "/healthz",
  "/status",
  "/docs",
  "/openapi.json",

  // legacy simulate endpoints
  "/api/v1/fees/simulate",
  "/api/v1/commissions/simulate",

  // legacy FX public rate
  "/api/v1/exchange-rates/rate",

  // ✅ nouveau: endpoints read-only signés
  "/api/v1/public",

  // internal routes (protégées dans leurs routes)
  "/internal/transactions",
  "/api/v1/internal",
];

app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const isOpen = openEndpoints.some((ep) => req.path === ep || req.path.startsWith(ep + "/"));
  if (isOpen) return next();

  return authMiddleware(req, res, next);
});

// ─────────── /public/* : signature HMAC obligatoire ───────────
app.use("/api/v1/public", (req, res, next) => {
  // Si tu n'as PAS encore configuré la clé, on renvoie un message clair.
  if (!config.publicReadonlySecret) {
    return res.status(503).json({
      success: false,
      message: "Public read-only is not configured (missing PUBLIC_READONLY_HMAC_SECRET).",
    });
  }

  const out = config.verifyPublicSignature(req);
  if (!out.ok) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized (public signature required)",
      reason: out.reason,
      age: out.age,
    });
  }
  req.publicSig = out;
  return next();
});

// ✅ Mount read-only public routes
app.use("/api/v1/public", publicRoutes);

// Ajout headers audit après auth (req.user si JWT ok)
app.use(auditHeaders);

// Rate limit par utilisateur pour routes authentifiées
app.use(userLimiter);

// ─────────── DB READY STATE (bloque uniquement les routes DB) ───────────
app.use((req, res, next) => {
  // endpoints "open" et docs sont servis AVANT, donc ici on protège le reste
  if (mongoose.connection.readyState !== 1) {
    logger.error("[MONGO] Requête refusée, MongoDB non connecté !");
    return res.status(500).json({ success: false, error: "MongoDB non connecté" });
  }
  return next();
});

// ─────────── ROUTES PRINCIPALES ───────────
app.use("/api/v1/pay", paymentRoutes);

// legacy internal
app.use("/internal/transactions", internalTransactionsRouter);

// nouvelles routes internes versionnées
app.use("/api/v1/internal", internalRoutes);

// users
app.use("/api/v1/transactions", userTransactionRoutes);

// admins
app.use("/api/v1/admin/transactions", transactionRoutes);

app.use("/api/v1/aml", amlRoutes);
app.use("/api/v1/fees", feesRoutes);
app.use("/api/v1/exchange-rates", exchangeRateRoutes);
app.use("/api/v1/commissions", commissionsRoutes);

// pricing + fx rules
app.use("/api/v1/pricing", pricingRoutes);
app.use("/api/v1/fx-rules", fxRulesRoutes);

// phone verification
app.use("/api/v1/phone-verification", phoneVerificationRoutes);

// ─────────── 404 & ERROR HANDLERS ───────────
app.use((req, res) => res.status(404).json({ success: false, error: "Ressource non trouvée" }));

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
