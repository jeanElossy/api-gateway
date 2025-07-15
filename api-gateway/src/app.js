const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const morgan = require('morgan');
const paymentRoutes = require('../routes/payment');
const amlRoutes = require('../routes/aml');
const transactionRoutes = require('../routes/transactions');
const { authMiddleware } = require('./middlewares/auth');
const { rateLimiter } = require('./middlewares/rateLimit');
const { loggerMiddleware } = require('./middlewares/logger');
const logger = require('./logger');
const mongoose = require('mongoose');
const { getAllProviders, getProvider } = require('./providers');
const axios = require('axios');
const auditHeaders = require('./middlewares/auditHeaders');

const app = express();

// ─────────── SÉCURITÉ & LOG ───────────
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    if (config.cors.origins.includes('*')) return callback(null, true);
    if (!origin) return callback(null, false);
    if (config.cors.origins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS: origine non autorisée'));
  },
  credentials: true
}));

if (config.nodeEnv !== 'test') {
  app.use(morgan(config.logging.level === 'debug' ? 'dev' : 'combined'));
}

app.use(express.json({ limit: '2mb' }));
app.use(loggerMiddleware);
app.use(rateLimiter);

// ─────────── AUTH GLOBAL GATEWAY ───────────
// Auth avant tout ! (Sauf /healthz et /status qui restent publiques pour l'infra/monitoring)
app.use((req, res, next) => {
  const openEndpoints = ['/healthz', '/status'];
  if (openEndpoints.includes(req.path)) return next();
  authMiddleware(req, res, next);
});
app.use(auditHeaders); // Ajoute les headers d’audit à chaque requête

// ─────────── DB READY STATE ───────────
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('[MONGO] Requête refusée, MongoDB non connecté !');
    return res.status(500).json({ success: false, error: 'MongoDB non connecté' });
  }
  next();
});

// ─────────── ROUTES PRINCIPALES ───────────
app.use('/api/v1/pay', paymentRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/aml', amlRoutes);

// ─────────── ROUTES DE MONITORING ───────────
// Probe ultra-rapide pour k8s/load-balancer/uptime robot
app.get('/healthz', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Status distribué : ping chaque microservice du providers.json
app.get('/status', async (req, res) => {
  const statuses = {};
  await Promise.all(getAllProviders().map(async (name) => {
    const p = getProvider(name);
    if (!p || !p.enabled) return;
    try {
      const health = await axios.get(p.url + (p.health || '/health'), { timeout: 3000 });
      statuses[name] = { up: true, status: health.data.status || 'ok' };
    } catch (err) {
      statuses[name] = { up: false, error: err.message };
    }
  }));
  res.json({ gateway: 'ok', microservices: statuses });
});

// ─────────── 404 HANDLER ───────────
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

// ─────────── ERROR HANDLER GLOBAL ───────────
app.use((err, req, res, next) => {
  // Ne JAMAIS envoyer la stack côté client en prod !
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
    error: (err.isJoi && err.details) ? err.details.map(d => d.message).join('; ')
          : err.message || 'Erreur serveur',
  });
});

module.exports = app;
