// src/middlewares/rateLimit.js

const rateLimit = require('express-rate-limit');
const config = require('../config');

// Limiteur général (adaptable par route si besoin)
const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,    // Ex: 60000 ms = 1 min
  max: config.rateLimit.max,              // Ex: 100 requêtes/minute
  standardHeaders: true,                  // Retourne les headers RateLimit standard
  legacyHeaders: false,                   // Désactive les vieux headers X-RateLimit-*
  message: {
    success: false,
    error: 'Trop de requêtes. Réessayez dans quelques instants.',
  }
});

module.exports = { rateLimiter };
