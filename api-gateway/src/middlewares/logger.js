// src/middlewares/logger.js

const logger = require('../logger');

// Champs à masquer dans les logs (RGPD, PCI DSS, etc.)
const SENSITIVE_FIELDS = [
  'password', 'cardNumber', 'cvc', 'securityCode', 'token', 'code', 'otp'
];

// Fonction récursive qui masque les champs sensibles dans les objets imbriqués
function maskSensitive(data) {
  if (!data || typeof data !== 'object') return data;
  const masked = {};
  for (const key in data) {
    if (SENSITIVE_FIELDS.includes(key)) {
      masked[key] = '***';
    } else if (typeof data[key] === 'object' && data[key] !== null) {
      masked[key] = maskSensitive(data[key]);
    } else {
      masked[key] = data[key];
    }
  }
  return masked;
}

/**
 * Middleware de logging avancé pour Express
 * - Loggue la méthode, URL, statut, durée, user, IP, params, etc.
 * - Masque les champs sensibles dans le body pour la privacy/compliance
 * - Capte et loggue le contenu de la réponse (utile pour audit/failures)
 */
module.exports.loggerMiddleware = (req, res, next) => {
  const start = Date.now();
  const { method, originalUrl, body, query } = req;

  // On capture la réponse si status > 399 (pour les erreurs API)
  const defaultWrite = res.write;
  const defaultEnd = res.end;
  let responseBody = '';

  // Override res.write pour stocker la réponse
  res.write = function (chunk, ...args) {
    responseBody += chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
    return defaultWrite.apply(res, [chunk, ...args]);
  };

  // Override res.end pour stocker la fin de la réponse
  res.end = function (chunk, ...args) {
    if (chunk) responseBody += chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
    defaultEnd.apply(res, [chunk, ...args]);
  };

  // Log à la fin de la requête (status connu)
  res.on('finish', () => {
    const duration = Date.now() - start;

    // Masque les champs sensibles du body (POST/PUT/PATCH)
    const safeBody = maskSensitive(body);

    // Parse la réponse JSON pour extraire l'erreur (si possible)
    let safeResp = {};
    if (responseBody && res.statusCode >= 400) {
      try { safeResp = JSON.parse(responseBody); } catch (e) { /* Pas du JSON, on ignore */ }
    }

    // Construction du log complet
    const logMsg = {
      timestamp: new Date().toISOString(),
      method,
      url: originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      user: req.user?.email || null,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] || null,
      query,
      body: method === 'GET' ? undefined : safeBody,
      error: res.statusCode >= 400 ? (safeResp.error || safeResp.message || responseBody) : undefined
    };

    // Niveau de log selon status
    if (res.statusCode >= 400) {
      logger.error('[API ERROR]', logMsg);
    } else {
      logger.info('[API]', logMsg);
    }
  });

  next();
};
