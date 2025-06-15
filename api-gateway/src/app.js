// src/app.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const morgan = require('morgan');
const paymentRoutes = require('../routes/payment');
const transactionRoutes = require('../routes/transactions'); // ← ajoute si tu as transactions
const { authMiddleware } = require('./middlewares/auth');
const { rateLimiter } = require('./middlewares/rateLimit');
const { loggerMiddleware } = require('./middlewares/logger');
const logger = require('./logger'); // WINSTON

const app = express();

// 1️⃣ Headers HTTP ultra-sécurisés
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

// 2️⃣ CORS avec whitelist dynamique (PRO)
app.use(cors({
  origin: (origin, callback) => {
    if (config.cors.origins.includes('*')) return callback(null, true);
    if (!origin) return callback(null, false);
    if (config.cors.origins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS: origine non autorisée'));
  },
  credentials: true
}));

// 3️⃣ Logging HTTP standard
if (config.nodeEnv !== 'test') {
  app.use(morgan(config.logging.level === 'debug' ? 'dev' : 'combined'));
}

// 4️⃣ Middlewares personnalisés
app.use(express.json({ limit: '2mb' }));
app.use(loggerMiddleware);
app.use(rateLimiter);
app.use(authMiddleware);

// 5️⃣ Routing métier
app.use('/api/pay', paymentRoutes);
app.use('/api/transactions', transactionRoutes); // ← branche tes routes transactions ici

// 6️⃣ 404 global (API REST style)
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

// 7️⃣ Gestion d’erreur globale (jamais de stack côté client)
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
    body: req.body, // ou maskSensitive(req.body) si tu veux masquer ici aussi
  });
  res.status(err.status || 500).json({
    success: false,
    error: (err.isJoi && err.details) ? err.details.map(d => d.message).join('; ')
          : err.message || 'Erreur serveur',
  });
});

module.exports = app;
