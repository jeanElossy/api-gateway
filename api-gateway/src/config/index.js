

// File: api-gateway/src/config/index.js
"use strict";

const Joi = require("joi");
const path = require("path");
const crypto = require("crypto");

/**
 * ✅ Tokens
 * - GATEWAY_INTERNAL_TOKEN : protège les routes internes du gateway (x-internal-token)
 * - PRINCIPAL_INTERNAL_TOKEN : token pour appeler le backend principal
 * - INTERNAL_TOKEN : fallback legacy
 *
 * ✅ Public read-only signature
 * - PUBLIC_READONLY_HMAC_SECRET : secret HMAC pour /api/v1/public/*
 * - PUBLIC_SIGNATURE_TTL_SEC : TTL anti-replay (default 60s)
 *
 * ✅ Principal transactions merge
 * - PRINCIPAL_TX_LIST_PATH : endpoint du principal pour lister les tx (cagnottes/ledger)
 * - PRINCIPAL_TX_TIMEOUT_MS : timeout appel principal
 */

const schema = Joi.object({
  NODE_ENV: Joi.string().valid("development", "production", "test").default("development"),
  PORT: Joi.number().integer().min(1).default(4000),
  JWT_SECRET: Joi.string().min(16).required(),

  // legacy
  INTERNAL_TOKEN: Joi.string().min(16).allow("").optional(),

  // recommended
  GATEWAY_INTERNAL_TOKEN: Joi.string().min(16).allow("").optional(),
  PRINCIPAL_INTERNAL_TOKEN: Joi.string().min(16).allow("").optional(),

  // backend principal (optionnel)
  PRINCIPAL_URL: Joi.string().uri().allow("").optional(),

  // ✅ principal tx list (optionnel)
  PRINCIPAL_TX_LIST_PATH: Joi.string().allow("").optional(),
  PRINCIPAL_TX_TIMEOUT_MS: Joi.number().integer().min(1000).optional(),

  // microservices
  SERVICE_PAYNOVAL_URL: Joi.string().uri().required(),
  SERVICE_BANK_URL: Joi.string().uri().allow("").optional(),
  SERVICE_MOBILEMONEY_URL: Joi.string().uri().allow("").optional(),
  SERVICE_STRIPE_URL: Joi.string().uri().allow("").optional(),
  SERVICE_VISA_DIRECT_URL: Joi.string().uri().allow("").optional(),
  SERVICE_STRIPE2MOMO_URL: Joi.string().uri().allow("").optional(),
  SERVICE_CASHIN_URL: Joi.string().uri().allow("").optional(),
  SERVICE_CASHOUT_URL: Joi.string().uri().allow("").optional(),
  SERVICE_FLUTTERWAVE_URL: Joi.string().uri().allow("").optional(),

  // CORS
  CORS_ORIGINS: Joi.string().default("*"),
  ADMIN_CORS_ORIGINS: Joi.string().allow("").optional(),
  MOBILE_CORS_ORIGINS: Joi.string().allow("").optional(),
  CORS_CREDENTIALS: Joi.string().valid("true", "false").default("true"),

  // Logging/monitoring
  LOGS_LEVEL: Joi.string().valid("error", "warn", "info", "debug").default("info"),
  SENTRY_DSN: Joi.string().allow("").optional(),

  // Rate limiting legacy
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(100),

  // Rate limiting optionnel
  PUBLIC_RL_WINDOW_MS: Joi.number().integer().min(1000).optional(),
  PUBLIC_RL_MAX: Joi.number().integer().min(1).optional(),
  ADMIN_RL_WINDOW_MS: Joi.number().integer().min(1000).optional(),
  ADMIN_RL_MAX: Joi.number().integer().min(1).optional(),

  // Public signature HMAC
  PUBLIC_READONLY_HMAC_SECRET: Joi.string().min(16).allow("").optional(),
  PUBLIC_SIGNATURE_TTL_SEC: Joi.number().integer().min(10).default(60),

  // DB URIs (optionnels)
  MONGO_URI_USERS: Joi.string().uri().allow("").optional(),
  MONGO_URI_GATEWAY: Joi.string().uri().allow("").optional(),

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

// ---------------- Helpers ----------------
const normStr = (v) => {
  const s = String(v ?? "").trim();
  return s ? s : "";
};

const splitCSV = (v) =>
  normStr(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// constant-time compare for hex strings
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------- Tokens ----------------
const legacyToken = normStr(env.INTERNAL_TOKEN || "");
const gatewayInternalToken = normStr(env.GATEWAY_INTERNAL_TOKEN || "") || legacyToken;
const principalInternalToken = normStr(env.PRINCIPAL_INTERNAL_TOKEN || "") || legacyToken;

// Guard prod: recommandé d'avoir au moins le token gateway
if (env.NODE_ENV === "production") {
  if (!gatewayInternalToken) {
    console.error("❌ GATEWAY_INTERNAL_TOKEN manquant (ou INTERNAL_TOKEN fallback).");
    process.exit(1);
  }
  if (!principalInternalToken && normStr(env.PRINCIPAL_URL || "")) {
    console.warn(
      "⚠️ PRINCIPAL_INTERNAL_TOKEN manquant: si tu proxifies vers le backend principal avec x-internal-token, ça peut échouer."
    );
  }
}

// ---------------- Public Signature (HMAC) ----------------
const publicReadonlySecret = normStr(env.PUBLIC_READONLY_HMAC_SECRET || "");
const publicSignatureTtlSec = Number(env.PUBLIC_SIGNATURE_TTL_SEC || 60);

function normalizePath(p) {
  const s = String(p || "").trim();
  if (!s.startsWith("/")) return "/" + s;
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

function flattenAndSortQuery(queryObj) {
  const pairs = [];

  for (const k of Object.keys(queryObj || {})) {
    const val = queryObj[k];
    if (val === undefined || val === null || String(val) === "") continue;

    if (Array.isArray(val)) {
      for (const v of val) {
        if (v === undefined || v === null || String(v) === "") continue;
        pairs.push([String(k), String(v)]);
      }
    } else {
      pairs.push([String(k), String(val)]);
    }
  }

  pairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function hmacSha256Hex(secret, payload) {
  return crypto.createHmac("sha256", String(secret)).update(String(payload)).digest("hex");
}

function canonicalString({ ts, method, path: pth, query }) {
  const m = String(method || "GET").toUpperCase();
  const p = normalizePath(pth || "/");
  const qs = flattenAndSortQuery(query || {});
  return `${String(ts)}\n${m}\n${p}\n${qs}`;
}

// ---------------- CORS / RateLimit ----------------
const legacyCorsOrigins =
  env.CORS_ORIGINS === "*"
    ? ["*"]
    : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

const adminOrigins = splitCSV(env.ADMIN_CORS_ORIGINS || "");
const mobileOrigins = splitCSV(env.MOBILE_CORS_ORIGINS || "");

// ---------------- URLs / DB ----------------
const principalUrl = normStr(env.PRINCIPAL_URL || "").replace(/\/+$/, "");
const mongoUsers = normStr(env.MONGO_URI_USERS || "");
const mongoGateway = normStr(env.MONGO_URI_GATEWAY || "");

// ✅ principal tx list path/timeout
const principalTxListPath = normalizePath(
  normStr(env.PRINCIPAL_TX_LIST_PATH || "/api/v1/cagnottes/transactions/me")
);
const principalTxTimeoutMs = Number(env.PRINCIPAL_TX_TIMEOUT_MS || 15000);

module.exports = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  jwtSecret: env.JWT_SECRET,

  // legacy + nouveaux
  internalToken: gatewayInternalToken || principalInternalToken || legacyToken,
  gatewayInternalToken,
  principalInternalToken,

  // public signature
  publicReadonlySecret,
  publicSignatureTtlSec,

  // backend principal
  principalUrl,

  // ✅ principal tx list
  principalTxListPath,
  principalTxTimeoutMs,

  microservices: {
    paynoval: normStr(env.SERVICE_PAYNOVAL_URL || "").replace(/\/+$/, ""),
    bank: normStr(env.SERVICE_BANK_URL || "").replace(/\/+$/, ""),
    mobilemoney: normStr(env.SERVICE_MOBILEMONEY_URL || "").replace(/\/+$/, ""),
    stripe: normStr(env.SERVICE_STRIPE_URL || "").replace(/\/+$/, ""),
    visa_direct: normStr(env.SERVICE_VISA_DIRECT_URL || "").replace(/\/+$/, ""),
    stripe2momo: normStr(env.SERVICE_STRIPE2MOMO_URL || "").replace(/\/+$/, ""),
    cashin: normStr(env.SERVICE_CASHIN_URL || "").replace(/\/+$/, ""),
    cashout: normStr(env.SERVICE_CASHOUT_URL || "").replace(/\/+$/, ""),
    flutterwave: normStr(env.SERVICE_FLUTTERWAVE_URL || "").replace(/\/+$/, ""),
  },

  cors: {
    origins: legacyCorsOrigins,
    adminOrigins,
    mobileOrigins,
    allowCredentials: String(env.CORS_CREDENTIALS || "true") === "true",
  },

  logging: {
    level: env.LOGS_LEVEL,
    sentryDsn: env.SENTRY_DSN,
    logsDir: path.join(__dirname, "..", "..", "logs"),
  },

  rateLimit: {
    windowMs: Number(env.RATE_LIMIT_WINDOW_MS),
    max: Number(env.RATE_LIMIT_MAX),
    public: {
      windowMs: Number(env.PUBLIC_RL_WINDOW_MS || env.RATE_LIMIT_WINDOW_MS),
      max: Number(env.PUBLIC_RL_MAX || Math.max(Number(env.RATE_LIMIT_MAX), 120)),
    },
    admin: {
      windowMs: Number(env.ADMIN_RL_WINDOW_MS || env.RATE_LIMIT_WINDOW_MS),
      max: Number(env.ADMIN_RL_MAX || Math.max(Number(env.RATE_LIMIT_MAX), 300)),
    },
  },

  dbUris: {
    users: mongoUsers || null,
    gateway: mongoGateway || null,
  },

  fraudAlert: {
    email: normStr(env.FRAUD_ALERT_EMAIL || "") || null,
    webhookUrl: normStr(env.FRAUD_ALERT_WEBHOOK_URL || "") || null,
  },

  verifyInternalToken(req) {
    const got = req.get("x-internal-token");
    const expected = String(gatewayInternalToken || "");
    if (!expected || !got) return false;
    const a = Buffer.from(String(got));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  },

  verifyPublicSignature(req) {
    const secret = String(publicReadonlySecret || "");
    if (!secret) return { ok: false, reason: "public_secret_missing" };

    const sig = String(req.get("x-signature") || "");
    const tsRaw = String(req.get("x-ts") || "");
    if (!sig || !tsRaw) return { ok: false, reason: "missing_headers" };

    let ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return { ok: false, reason: "invalid_ts" };
    if (ts > 10_000_000_000) ts = Math.floor(ts / 1000);

    const age = Math.abs(nowSec() - ts);
    const ttl = Number(publicSignatureTtlSec || 60);
    if (ttl > 0 && age > ttl) return { ok: false, reason: "ts_expired", age };

    const fullPath = normalizePath(`${req.baseUrl || ""}${req.path || ""}`);

    const payload = canonicalString({
      ts,
      method: req.method,
      path: fullPath,
      query: req.query || {},
    });

    const expected = hmacSha256Hex(secret, payload);

    if (!safeEqualHex(sig, expected)) {
      return { ok: false, reason: "bad_signature", age };
    }

    return { ok: true, ts, age, path: fullPath };
  },
};
