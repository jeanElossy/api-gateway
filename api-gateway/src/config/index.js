const Joi = require('joi');
const path = require('path');

const schema = Joi.object({
  NODE_ENV:       Joi.string().valid('development', 'production', 'test').default('development'),
  PORT:           Joi.number().integer().min(1).default(4000),
  JWT_SECRET:     Joi.string().min(16).required(),
  INTERNAL_TOKEN: Joi.string().min(16).required(),

  // Microservices
  SERVICE_PAYNOVAL_URL:     Joi.string().uri().required(),
  SERVICE_BANK_URL:         Joi.string().uri().required(),
  SERVICE_MOBILEMONEY_URL:  Joi.string().uri().required(),
  SERVICE_STRIPE_URL:       Joi.string().uri().required(),
  SERVICE_VISA_DIRECT_URL:  Joi.string().uri().required(),
  SERVICE_STRIPE2MOMO_URL:  Joi.string().uri().required(),
  SERVICE_CASHIN_URL:       Joi.string().uri().required(),
  SERVICE_CASHOUT_URL:      Joi.string().uri().required(),
  SERVICE_FLUTTERWAVE_URL:  Joi.string().uri().required(), // <-- Ajouté

  // CORS
  CORS_ORIGINS:  Joi.string().default('*'),

  // Logging/monitoring
  LOGS_LEVEL:    Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  SENTRY_DSN:    Joi.string().allow('').optional(),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_MAX:       Joi.number().integer().min(1).default(100),

  // DB URIs
  MONGO_URI_USERS:   Joi.string().uri().required(),
  MONGO_URI_GATEWAY: Joi.string().uri().required(),

  // AML/fraude alertes
  FRAUD_ALERT_EMAIL: Joi.string().email().allow('').optional(),
  FRAUD_ALERT_WEBHOOK_URL: Joi.string().uri().allow('').optional(),
})
  .unknown()
  .required();

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
    visa_direct: env.SERVICE_VISA_DIRECT_URL,
    stripe2momo: env.SERVICE_STRIPE2MOMO_URL,
    cashin:      env.SERVICE_CASHIN_URL,
    cashout:     env.SERVICE_CASHOUT_URL,
    flutterwave: env.SERVICE_FLUTTERWAVE_URL, // <-- Ajouté
  },

  cors: {
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
  },

  dbUris: {
    users: env.MONGO_URI_USERS,
    gateway: env.MONGO_URI_GATEWAY,
  },

  fraudAlert: {
    email: env.FRAUD_ALERT_EMAIL || null,
    webhookUrl: env.FRAUD_ALERT_WEBHOOK_URL || null
  }
};
