// src/app.js

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

const app = express(); // ← D’ABORD tu déclares app ici !

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
app.use(authMiddleware);

app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('[MONGO] Requête refusée, MongoDB non connecté !');
    return res.status(500).json({ success: false, error: 'MongoDB non connecté' });
  }
  next();
});

app.use('/api/v1/pay', paymentRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/aml', amlRoutes);

app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

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
    error: (err.isJoi && err.details) ? err.details.map(d => d.message).join('; ')
          : err.message || 'Erreur serveur',
  });
});

module.exports = app;
