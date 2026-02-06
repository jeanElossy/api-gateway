"use strict";

const Joi = require("joi");
const path = require("path");
const crypto = require("crypto");

/**
 * ✅ Tokens
 *
 * - GATEWAY_INTERNAL_TOKEN : protège les routes internes du gateway (x-internal-token)
 * - PRINCIPAL_INTERNAL_TOKEN : token pour appeler le backend principal
 *
 * 🔁 Rétro-compatibilité:
 * - INTERNAL_TOKEN fallback (ancien système)
 *
 * ✅ Ajouts (moderne/clean)
 * - PUBLIC_READONLY_HMAC_SECRET : secret HMAC pour /api/v1/public/*
 * - PUBLIC_SIGNATURE_TTL_SEC : TTL anti-replay (default 60s)
 * - ADMIN_CORS_ORIGINS, MOBILE_CORS_ORIGINS : allowlists spécifiques (optionnels)
 * - CORS_CREDENTIALS : default true
 * - PUBLIC_RL_*, ADMIN_RL_* : rate limits séparés (optionnels)
 */

const schema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().integer().min(1).default(4000),
  JWT_SECRET: Joi.string().min(16).required(),

  // ✅ Legacy (fallback)
  INTERNAL_TOKEN: Joi.string().min(16).optional(),

  // ✅ Recommandés (nouveaux)
  GATEWAY_INTERNAL_TOKEN: Joi.string().min(16).optional(),
  PRINCIPAL_INTERNAL_TOKEN: Joi.string().min(16).optional(),

  // ✅ Backend principal (optionnel si ton gateway l’utilise via config ailleurs)
  PRINCIPAL_URL: Joi.string().uri().allow("").optional(),

  // Microservices
  SERVICE_PAYNOVAL_URL: Joi.string().uri().required(),
  SERVICE_BANK_URL: Joi.string().uri().required(),
  SERVICE_MOBILEMONEY_URL: Joi.string().uri().required(),
  SERVICE_STRIPE_URL: Joi.string().uri().required(),
  SERVICE_VISA_DIRECT_URL: Joi.string().uri().required(),
  SERVICE_STRIPE2MOMO_URL: Joi.string().uri().required(),
  SERVICE_CASHIN_URL: Joi.string().uri().required(),
  SERVICE_CASHOUT_URL: Joi.string().uri().required(),
  SERVICE_FLUTTERWAVE_URL: Joi.string().uri().required(),

  // CORS (legacy)
  CORS_ORIGINS: Joi.string().default("*"),

  // ✅ CORS (nouveau, optionnel)
  ADMIN_CORS_ORIGINS: Joi.string().allow("").optional(),
  MOBILE_CORS_ORIGINS: Joi.string().allow("").optional(),
  CORS_CREDENTIALS: Joi.string().valid("true", "false").default("true"),

  // Logging/monitoring
  LOGS_LEVEL: Joi.string().valid("error", "warn", "info", "debug").default("info"),
  SENTRY_DSN: Joi.string().allow("").optional(),

  // Rate limiting (legacy)
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(100),

  // ✅ Rate limiting (nouveau, optionnel)
  PUBLIC_RL_WINDOW_MS: Joi.number().integer().min(1000).optional(),
  PUBLIC_RL_MAX: Joi.number().integer().min(1).optional(),
  ADMIN_RL_WINDOW_MS: Joi.number().integer().min(1000).optional(),
  ADMIN_RL_MAX: Joi.number().integer().min(1).optional(),

  // ✅ Public read-only signature HMAC (nouveau, optionnel)
  PUBLIC_READONLY_HMAC_SECRET: Joi.string().min(16).allow("").optional(),
  PUBLIC_SIGNATURE_TTL_SEC: Joi.number().integer().min(10).default(60),

  // DB URIs
  MONGO_URI_USERS: Joi.string().uri().required(),
  MONGO_URI_GATEWAY: Joi.string().uri().required(),

  // AML/fraude alertes
  FRAUD_ALERT_EMAIL: Joi.string().email().allow("").optional(),
  FRAUD_ALERT_WEBHOOK_URL: Joi.string().uri().allow("").optional(),
})
  .unknown()
  .required();

const { error, value: env } = schema.validate(process.env, {
  abortEarly: false,
  convert: true,
});

if (error) {
  console.error(
    "❌ Mauvaise configuration API Gateway :\n",
    error.details.map((d) => d.message).join("\n")
  );
  process.exit(1);
}

// ✅ Helpers
const normStr = (v) => {
  const s = String(v ?? "").trim();
  return s ? s : "";
};

const splitCSV = (v) =>
  normStr(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// ✅ Safe constant-time compare
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// ✅ Résolution tokens (rétro-compat)
const legacyToken = env.INTERNAL_TOKEN || "";
const gatewayInternalToken = env.GATEWAY_INTERNAL_TOKEN || legacyToken;
const principalInternalToken = env.PRINCIPAL_INTERNAL_TOKEN || legacyToken;

// ✅ Petit guard pro : en production on veut au moins 1 token interne
if (env.NODE_ENV === "production") {
  if (!gatewayInternalToken) {
    console.error("❌ GATEWAY_INTERNAL_TOKEN manquant (ou INTERNAL_TOKEN fallback).");
    process.exit(1);
  }
  if (!principalInternalToken) {
    console.error("❌ PRINCIPAL_INTERNAL_TOKEN manquant (ou INTERNAL_TOKEN fallback).");
    process.exit(1);
  }
}

/**
 * ✅ HMAC canonical string
 * payload = ts + "\n" + METHOD + "\n" + PATH + "\n" + sortedQueryString
 */
function canonicalString({ ts, method, path, query }) {
  const m = String(method || "GET").toUpperCase();
  const p = String(path || "/");
  const q = query || {};
  const qs = Object.keys(q)
    .sort()
    .map((k) => `${k}=${String(q[k])}`)
    .join("&");
  return `${String(ts)}\n${m}\n${p}\n${qs}`;
}

function hmacSign(secret, payload) {
  return crypto.createHmac("sha256", String(secret)).update(String(payload)).digest("hex");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ✅ Build CORS origins (compat legacy + nouveaux)
const legacyCorsOrigins =
  env.CORS_ORIGINS === "*"
    ? ["*"]
    : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

const adminOrigins = splitCSV(env.ADMIN_CORS_ORIGINS || "");
const mobileOrigins = splitCSV(env.MOBILE_CORS_ORIGINS || "");

// ✅ Rate limits (legacy + nouveaux)
const legacyRate = {
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
};

const publicRate = {
  windowMs: Number(env.PUBLIC_RL_WINDOW_MS || legacyRate.windowMs),
  max: Number(env.PUBLIC_RL_MAX || Math.max(legacyRate.max, 120)),
};

const adminRate = {
  windowMs: Number(env.ADMIN_RL_WINDOW_MS || legacyRate.windowMs),
  max: Number(env.ADMIN_RL_MAX || Math.max(legacyRate.max, 300)),
};

module.exports = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  jwtSecret: env.JWT_SECRET,

  /**
   * ✅ IMPORTANT
   * - internalToken => utilisé historiquement partout (legacy)
   * - gatewayInternalToken => token interne du gateway
   * - principalInternalToken => token pour appeler le backend principal
   */
  internalToken: legacyToken || gatewayInternalToken || principalInternalToken,
  gatewayInternalToken,
  principalInternalToken,

  // ✅ Public read-only HMAC
  publicReadonlySecret: normStr(env.PUBLIC_READONLY_HMAC_SECRET || ""),
  publicSignatureTtlSec: Number(env.PUBLIC_SIGNATURE_TTL_SEC || 60),

  // Backend principal (optionnel)
  principalUrl: (env.PRINCIPAL_URL || "").replace(/\/+$/, ""),

  microservices: {
    paynoval: env.SERVICE_PAYNOVAL_URL,
    bank: env.SERVICE_BANK_URL,
    mobilemoney: env.SERVICE_MOBILEMONEY_URL,
    stripe: env.SERVICE_STRIPE_URL,
    visa_direct: env.SERVICE_VISA_DIRECT_URL,
    stripe2momo: env.SERVICE_STRIPE2MOMO_URL,
    cashin: env.SERVICE_CASHIN_URL,
    cashout: env.SERVICE_CASHOUT_URL,
    flutterwave: env.SERVICE_FLUTTERWAVE_URL,
  },

  // ✅ CORS (compat + nouveau)
  cors: {
    // legacy (ton app.js l'utilise déjà)
    origins: legacyCorsOrigins,

    // nouveaux
    adminOrigins,
    mobileOrigins,
    allowCredentials: String(env.CORS_CREDENTIALS || "true") === "true",
  },

  logging: {
    level: env.LOGS_LEVEL,
    sentryDsn: env.SENTRY_DSN,
    logsDir: path.join(__dirname, "..", "..", "logs"),
  },

  // ✅ Rate limits (compat + nouveau)
  rateLimit: {
    // legacy (tes middlewares actuels peuvent l'utiliser)
    windowMs: legacyRate.windowMs,
    max: legacyRate.max,

    // nouveaux (pour app.js)
    public: publicRate,
    admin: adminRate,
  },

  dbUris: {
    users: env.MONGO_URI_USERS,
    gateway: env.MONGO_URI_GATEWAY,
  },

  fraudAlert: {
    email: env.FRAUD_ALERT_EMAIL || null,
    webhookUrl: env.FRAUD_ALERT_WEBHOOK_URL || null,
  },

  // ✅ Helpers: internal token check (x-internal-token)
  verifyInternalToken(req) {
    const got = req.get("x-internal-token");
    const expected = String(gatewayInternalToken || "");
    if (!expected) return false;
    if (!got) return false;
    return safeEqual(got, expected);
  },

  // ✅ Helpers: public signature check (HMAC) for /api/v1/public/*
  verifyPublicSignature(req) {
    const secret = String(module.exports.publicReadonlySecret || "");
    if (!secret) return { ok: false, reason: "public_secret_missing" };

    const sig = req.get("x-signature") || "";
    const tsRaw = req.get("x-ts") || "";
    if (!sig || !tsRaw) return { ok: false, reason: "missing_headers" };

    // seconds or ms
    let ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_ts" };
    if (ts > 10_000_000_000) ts = Math.floor(ts / 1000);

    const age = Math.abs(nowSec() - ts);
    if (age > Number(module.exports.publicSignatureTtlSec || 60)) {
      return { ok: false, reason: "ts_expired", age };
    }

    // path = baseUrl + path (Express)
    const p = req.baseUrl
      ? String(req.baseUrl) + String(req.path || "")
      : String(req.path || req.originalUrl || "");

    const payload = canonicalString({
      ts,
      method: req.method,
      path: p,
      query: req.query || {},
    });

    const expected = hmacSign(secret, payload);
    if (!safeEqual(sig, expected)) return { ok: false, reason: "bad_signature" };

    return { ok: true, ts, age };
  },
};
