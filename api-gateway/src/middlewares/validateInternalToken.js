// File: api-gateway/src/middlewares/validateInternalToken.js
'use strict';

const config = require('../config');
const logger = require('../logger');

// Token partagé entre tes microservices (Gateway, api-paynoval, etc.)
const INTERNAL_TOKEN = config.internalToken || process.env.INTERNAL_TOKEN;

module.exports = function validateInternalToken(req, res, next) {
  const ip =
    req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (!INTERNAL_TOKEN) {
    logger.warn('[validateInternalToken] INTERNAL_TOKEN non défini dans la config/env', {
      ip,
      path: req.originalUrl,
      method: req.method,
    });
    return res.status(500).json({
      success: false,
      error: 'Configuration interne manquante (INTERNAL_TOKEN).',
    });
  }

  const headerToken = req.headers['x-internal-token'];

  if (!headerToken) {
    logger.warn('[validateInternalToken] x-internal-token manquant', {
      ip,
      path: req.originalUrl,
      method: req.method,
    });
    return res.status(401).json({
      success: false,
      error: 'Appel interne non autorisé (token manquant).',
    });
  }

  if (headerToken !== INTERNAL_TOKEN) {
    logger.warn('[validateInternalToken] x-internal-token invalide', {
      ip,
      path: req.originalUrl,
      method: req.method,
    });
    return res.status(401).json({
      success: false,
      error: 'Appel interne non autorisé (token invalide).',
    });
  }

  // OK, on laisse passer
  return next();
};
