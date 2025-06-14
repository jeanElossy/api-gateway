// File: src/config/index.js

const Joi = require('joi');
const path = require('path');

// 1️⃣ Définis le schéma de validation de TOUTES les variables d'env nécessaires à la gateway
const schema = Joi.object({
  // Serveur
  NODE_ENV:       Joi.string().valid('development', 'production', 'test').default('development'),
  PORT:           Joi.number().integer().min(1).default(4000),

  // Auth
  JWT_SECRET:     Joi.string().min(16).required(),
  INTERNAL_TOKEN: Joi.string().min(16).required(),

  // Microservices
  SERVICE_PAYNOVAL_URL:     Joi.string().uri().required(),
  SERVICE_BANK_URL:         Joi.string().uri().required(),
  SERVICE_MOBILEMONEY_URL:  Joi.string().uri().required(),
  SERVICE_STRIPE_URL:       Joi.string().uri().required(),

  // CORS
  CORS_ORIGINS:  Joi.string().default('*'), // ou "https://app.com,https://autre.com" pour prod

  // Logging/monitoring
  LOGS_LEVEL:   Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  SENTRY_DSN:   Joi.string().allow('').optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_MAX:       Joi.number().integer().min(1).default(100),
})
  .unknown()
  .required();

// 2️⃣ Validation à l'exécution
const { error, value: env } = schema.validate(process.env, {
  abortEarly: false,
  convert: true
});

if (error) {
  console.error(
    '❌ Mauvaise configuration API Gateway :\n',
    error.details.map(d => d.message).join('\n')
  );
  process.exit(1);
}

// 3️⃣ Export de la config (ultra claire)
module.exports = {
  nodeEnv:    env.NODE_ENV,
  port:       env.PORT,
  jwtSecret:  env.JWT_SECRET,
  internalToken: env.INTERNAL_TOKEN,

  microservices: {
    paynoval:    env.SERVICE_PAYNOVAL_URL,
    bank:        env.SERVICE_BANK_URL,
    mobilemoney: env.SERVICE_MOBILEMONEY_URL,
    stripe:      env.SERVICE_STRIPE_URL,
  },

  cors: {
    // découpé en array, vide = tous autorisés
    origins: env.CORS_ORIGINS === '*' ? ['*'] :
      env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  },

  logging: {
    level: env.LOGS_LEVEL,
    sentryDsn: env.SENTRY_DSN,
    logsDir: path.join(__dirname, '..', '..', 'logs')
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max:      env.RATE_LIMIT_MAX
  }
};
