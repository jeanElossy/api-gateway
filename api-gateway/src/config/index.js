// const Joi = require('joi');
// const path = require('path');

// const schema = Joi.object({
//   NODE_ENV:       Joi.string().valid('development', 'production', 'test').default('development'),
//   PORT:           Joi.number().integer().min(1).default(4000),
//   JWT_SECRET:     Joi.string().min(16).required(),
//   INTERNAL_TOKEN: Joi.string().min(16).required(),

//   // Microservices
//   SERVICE_PAYNOVAL_URL:     Joi.string().uri().required(),
//   SERVICE_BANK_URL:         Joi.string().uri().required(),
//   SERVICE_MOBILEMONEY_URL:  Joi.string().uri().required(),
//   SERVICE_STRIPE_URL:       Joi.string().uri().required(),
//   SERVICE_VISA_DIRECT_URL:  Joi.string().uri().required(),
//   SERVICE_STRIPE2MOMO_URL:  Joi.string().uri().required(),
//   SERVICE_CASHIN_URL:       Joi.string().uri().required(),
//   SERVICE_CASHOUT_URL:      Joi.string().uri().required(),
//   SERVICE_FLUTTERWAVE_URL:  Joi.string().uri().required(), // <-- Ajouté

//   // CORS
//   CORS_ORIGINS:  Joi.string().default('*'),

//   // Logging/monitoring
//   LOGS_LEVEL:    Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
//   SENTRY_DSN:    Joi.string().allow('').optional(),

//   // Rate limiting
//   RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
//   RATE_LIMIT_MAX:       Joi.number().integer().min(1).default(100),

//   // DB URIs
//   MONGO_URI_USERS:   Joi.string().uri().required(),
//   MONGO_URI_GATEWAY: Joi.string().uri().required(),

//   // AML/fraude alertes
//   FRAUD_ALERT_EMAIL: Joi.string().email().allow('').optional(),
//   FRAUD_ALERT_WEBHOOK_URL: Joi.string().uri().allow('').optional(),
// })
//   .unknown()
//   .required();

// const { error, value: env } = schema.validate(process.env, {
//   abortEarly: false,
//   convert: true
// });

// if (error) {
//   console.error(
//     '❌ Mauvaise configuration API Gateway :\n',
//     error.details.map(d => d.message).join('\n')
//   );
//   process.exit(1);
// }


// module.exports = {
//   nodeEnv:    env.NODE_ENV,
//   port:       env.PORT,
//   jwtSecret:  env.JWT_SECRET,
//   internalToken: env.INTERNAL_TOKEN,

//   microservices: {
//     paynoval:    env.SERVICE_PAYNOVAL_URL,
//     bank:        env.SERVICE_BANK_URL,
//     mobilemoney: env.SERVICE_MOBILEMONEY_URL,
//     stripe:      env.SERVICE_STRIPE_URL,
//     visa_direct: env.SERVICE_VISA_DIRECT_URL,
//     stripe2momo: env.SERVICE_STRIPE2MOMO_URL,
//     cashin:      env.SERVICE_CASHIN_URL,
//     cashout:     env.SERVICE_CASHOUT_URL,
//     flutterwave: env.SERVICE_FLUTTERWAVE_URL, // <-- Ajouté
//   },

//   cors: {
//     origins: env.CORS_ORIGINS === '*' ? ['*'] :
//       env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
//   },

//   logging: {
//     level: env.LOGS_LEVEL,
//     sentryDsn: env.SENTRY_DSN,
//     logsDir: path.join(__dirname, '..', '..', 'logs')
//   },

//   rateLimit: {
//     windowMs: env.RATE_LIMIT_WINDOW_MS,
//     max:      env.RATE_LIMIT_MAX
//   },

//   dbUris: {
//     users: env.MONGO_URI_USERS,
//     gateway: env.MONGO_URI_GATEWAY,
//   },

//   fraudAlert: {
//     email: env.FRAUD_ALERT_EMAIL || null,
//     webhookUrl: env.FRAUD_ALERT_WEBHOOK_URL || null
//   }
// };





"use strict";

const Joi = require("joi");
const path = require("path");

/**
 * ✅ Tokens (important pour ton système referral/bonus)
 *
 * - GATEWAY_INTERNAL_TOKEN : protège les routes internes du gateway (ex: /transactions/internal/log)
 * - PRINCIPAL_INTERNAL_TOKEN : sert UNIQUEMENT à appeler le backend principal via x-internal-token
 *
 * 🔁 Rétro-compatibilité:
 * - INTERNAL_TOKEN est gardé comme fallback (ancien système)
 *   => Si tu ne définis pas les nouveaux, on utilisera INTERNAL_TOKEN.
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

  // ✅ Backend principal (pour referral/bonus / notifications / wallet, etc.)
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

  // CORS
  CORS_ORIGINS: Joi.string().default("*"),

  // Logging/monitoring
  LOGS_LEVEL: Joi.string().valid("error", "warn", "info", "debug").default("info"),
  SENTRY_DSN: Joi.string().allow("").optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_MAX: Joi.number().integer().min(1).default(100),

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

// ✅ Résolution tokens (rétro-compat)
const legacyToken = env.INTERNAL_TOKEN || "";
const gatewayInternalToken = env.GATEWAY_INTERNAL_TOKEN || legacyToken;
const principalInternalToken = env.PRINCIPAL_INTERNAL_TOKEN || legacyToken;

// ✅ Petit guard pro : en production on veut au moins 1 token
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

  // Backend principal (optionnel si ton gateway l’utilise via config ailleurs)
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

  cors: {
    origins:
      env.CORS_ORIGINS === "*"
        ? ["*"]
        : env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  },

  logging: {
    level: env.LOGS_LEVEL,
    sentryDsn: env.SENTRY_DSN,
    logsDir: path.join(__dirname, "..", "..", "logs"),
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
  },

  dbUris: {
    users: env.MONGO_URI_USERS,
    gateway: env.MONGO_URI_GATEWAY,
  },

  fraudAlert: {
    email: env.FRAUD_ALERT_EMAIL || null,
    webhookUrl: env.FRAUD_ALERT_WEBHOOK_URL || null,
  },
};
