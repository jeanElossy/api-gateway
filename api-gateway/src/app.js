// src/app.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const morgan = require('morgan');
const paymentRoutes = require('../routes/payment');
const amlRoutes = require('../routes/aml');
const transactionRoutes = require('../routes/admin/transactions.admin.routes');
const feesRoutes = require('../routes/fees');
const exchangeRateRoutes = require('../routes/admin/exchangeRates.routes');
const commissionsRoutes = require('../routes/commissionsRoutes');
const { authMiddleware } = require('./middlewares/auth');
const { rateLimiter } = require('./middlewares/rateLimit');
const { loggerMiddleware } = require('./middlewares/logger');
const logger = require('./logger');
const mongoose = require('mongoose');
const { getAllProviders, getProvider } = require('./providers');
const axios = require('axios');
const auditHeaders = require('./middlewares/auditHeaders');
const userTransactionRoutes = require('../routes/transactions');

// 🔧 CORRECTION : chemin vers la route interne
const internalTransactionsRouter = require('../routes/internalTransactions');

// ✅ Swagger (docs Gateway)
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const openapiSpec = YAML.load(path.join(__dirname, '../docs/openapi.yaml'));

const app = express();

// ─────────── SÉCURITÉ & LOG ───────────
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (config.cors.origins.includes('*')) return callback(null, true);
      if (!origin) return callback(null, true); // ← autorise clients sans Origin (CLI/Postman)
      if (config.cors.origins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS: origine non autorisée'));
    },
    credentials: true,
  })
);

if (config.nodeEnv !== 'test') {
  app.use(morgan(config.logging.level === 'debug' ? 'dev' : 'combined'));
}

app.use(express.json({ limit: '2mb' }));
app.use(loggerMiddleware);
app.use(rateLimiter);

// ─────────── DOCS PUBLIQUES (avant auth) ───────────
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    explorer: true,
    customSiteTitle: 'PayNoval Gateway API',
  })
);

// ─────────── AUTH GLOBAL GATEWAY ───────────
const openEndpoints = [
  '/healthz',
  '/status',
  '/docs',                    // ← doc publique
  '/openapi.json',            // ← spec publique
  '/api/v1/fees/simulate',
  '/api/v1/commissions/simulate',
  '/api/v1/exchange-rates/rate',
  // 🔓 On laisse passer les appels internes (protégés par x-internal-token)
  '/internal/transactions',
  // tu pourras ajouter ici tes routes d'auth publiques (login/register) si besoin
  // '/api/v1/auth',
];

app.use((req, res, next) => {
  // 1) Toujours laisser passer les préflight CORS
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  // 2) Endpoints publics (docs, health, simulate, internal, etc.)
  const isOpen = openEndpoints.some(
    (ep) => req.path === ep || req.path.startsWith(ep + '/')
  );

  if (isOpen) return next();

  // 3) Tout le reste est protégé
  authMiddleware(req, res, next);
});

// Ajout des headers d'audit après auth (req.user déjà renseigné si JWT ok)
app.use(auditHeaders);

// ─────────── DB READY STATE ───────────
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('[MONGO] Requête refusée, MongoDB non connecté !');
    return res
      .status(500)
      .json({ success: false, error: 'MongoDB non connecté' });
  }
  next();
});

// ─────────── ROUTES PRINCIPALES ───────────
app.use('/api/v1/pay', paymentRoutes);

// 🔧 Route interne pour les notifs de transactions (API PayNoval → Gateway)
app.use('/internal/transactions', internalTransactionsRouter);

// Pour les utilisateurs normaux
app.use('/api/v1/transactions', userTransactionRoutes);

// Pour les admins
app.use('/api/v1/admin/transactions', transactionRoutes);

app.use('/api/v1/aml', amlRoutes);
app.use('/api/v1/fees', feesRoutes);
app.use('/api/v1/exchange-rates', exchangeRateRoutes);
app.use('/api/v1/commissions', commissionsRoutes);

// ─────────── MONITORING ───────────
app.get('/healthz', (req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString() })
);

app.get('/status', async (req, res) => {
  const statuses = {};
  await Promise.all(
    getAllProviders().map(async (name) => {
      const p = getProvider(name);
      if (!p || !p.enabled) return;
      try {
        const health = await axios.get(
          p.url + (p.health || '/health'),
          { timeout: 3000 }
        );
        statuses[name] = {
          up: true,
          status: health.data.status || 'ok',
        };
      } catch (err) {
        statuses[name] = {
          up: false,
          error: err.message,
        };
      }
    })
  );
  res.json({ gateway: 'ok', microservices: statuses });
});

// ─────────── 404 & ERROR HANDLERS ───────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: 'Ressource non trouvée' })
);

app.use((err, req, res, next) => {
  logger.error('[API ERROR]', {
    message: err.message,
    stack: err.stack,
    status: err.status,
    path: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    user: req.user?.email,
    body: req.body,
  });
  res.status(err.status || 500).json({
    success: false,
    error:
      err.isJoi && err.details
        ? err.details.map((d) => d.message).join('; ')
        : err.message || 'Erreur serveur',
  });
});

module.exports = app;
