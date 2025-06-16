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
const mongoose = require('mongoose'); // Pour readyState check

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

// 4bis️⃣ Sécurité : refuse toute requête si Mongo n’est pas prêt
app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    logger.error('[MONGO] Requête refusée, MongoDB non connecté !');
    return res.status(500).json({ success: false, error: 'MongoDB non connecté' });
  }
  next();
});

// 5️⃣ Routing métier
app.use('/api/v1/pay', paymentRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/aml', amlRoutes);

// 6️⃣ Endpoint de debug pour écriture transaction Gateway
app.post('/api/v1/transactions/debug-write', async (req, res) => {
  try {
    const Transaction = require('../src/models/Transaction');
    console.log('[DEBUG][GATEWAY] mongoose.connection.readyState:', mongoose.connection.readyState); // 1 = connecté
    console.log('[DEBUG][GATEWAY] Transaction model db:', Transaction.db?.name);
    const tx = await Transaction.create({
      userId: new mongoose.Types.ObjectId(),
      provider: 'paynoval',
      amount: Math.floor(Math.random() * 10000) + 1,
      status: 'pending',
      reference: 'debug-manuel-' + Date.now(),
      meta: { debug: true },
    });
    console.log('[DEBUG][GATEWAY] Transaction log créée dans la gateway:', tx._id);
    return res.json({ success: true, tx });
  } catch (err) {
    console.error('[ERROR][GATEWAY] Echec écriture transaction dans gateway:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7️⃣ 404 global (API REST style)
app.use((req, res, next) => {
  res.status(404).json({ success: false, error: 'Ressource non trouvée' });
});

// 8️⃣ Gestion d’erreur globale (jamais de stack côté client)
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
