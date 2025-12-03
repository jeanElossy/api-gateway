// File: api-gateway/src/middlewares/rateLimit.js

const rateLimit = require('express-rate-limit');
const logger = require('../logger');

// 🔰 1) Bouclier global par IP (tout le trafic, public + privé)
const globalIpLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  max: 300,                     // 300 requêtes / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res, next, options) => {
    logger.warn('[RateLimit][global-ip] Limite atteinte', {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });

    return res.status(options.statusCode).json({
      success: false,
      error: 'Trop de requêtes depuis cette adresse IP. Réessaie dans un instant.',
    });
  },
});

// 👤 2) Rate limit par utilisateur authentifié (req.user.*)
//    - si pas d’utilisateur (route publique) → skip = true → on ne limite pas ici
const userLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minute
  max: 60,                      // 60 requêtes / minute / utilisateur
  standardHeaders: true,
  legacyHeaders: false,

  // On ne l’applique QUE si l’utilisateur est authentifié
  skip: (req) => !req.user,

  keyGenerator: (req) => {
    if (req.user && (req.user.id || req.user._id)) {
      return `user:${req.user.id || req.user._id}`;
    }
    // Fallback sécurité, mais normalement skip() aura déjà court-circuité
    return req.ip;
  },

  handler: (req, res, next, options) => {
    logger.warn('[RateLimit][user] Limite atteinte', {
      userId: req.user && (req.user.id || req.user._id),
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
    });

    return res.status(options.statusCode).json({
      success: false,
      error: 'Trop de requêtes pour ce compte. Réessaie dans un instant.',
    });
  },
});

module.exports = {
  globalIpLimiter,
  userLimiter,
};
