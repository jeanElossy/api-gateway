// File: api-gateway/src/middlewares/validateInternalToken.js
'use strict';

const config = require('../config');
const logger = require('../logger');

// ✅ Supporte plusieurs noms d'env pour éviter les mismatchs entre services
// - INTERNAL_TOKEN : standard
// - GATEWAY_INTERNAL_TOKEN : pratique côté services appelants
const INTERNAL_TOKEN =
  config.internalToken ||
  process.env.INTERNAL_TOKEN ||
  process.env.GATEWAY_INTERNAL_TOKEN;

module.exports = function validateInternalToken(req, res, next) {
  const ip =
    req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (!INTERNAL_TOKEN) {
    logger.warn(
      '[validateInternalToken] Token interne manquant (INTERNAL_TOKEN/GATEWAY_INTERNAL_TOKEN)',
      {
        ip,
        path: req.originalUrl,
        method: req.method,
      }
    );
    return res.status(500).json({
      success: false,
      error: 'Configuration interne manquante (INTERNAL_TOKEN).',
    });
  }

  // ✅ Header en minuscules (Node normalise en lower-case)
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

  if (String(headerToken) !== String(INTERNAL_TOKEN)) {
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

  return next();
};
