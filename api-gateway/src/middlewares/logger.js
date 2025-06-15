// src/middlewares/logger.js

const logger = require('../logger');

const SENSITIVE_FIELDS = ['password', 'cardNumber', 'cvc', 'securityCode', 'token', 'code', 'otp'];

function maskSensitive(data) {
  if (!data || typeof data !== 'object') return data;
  const masked = {};
  for (const key in data) {
    if (SENSITIVE_FIELDS.includes(key)) {
      masked[key] = '***';
    } else if (typeof data[key] === 'object') {
      masked[key] = maskSensitive(data[key]);
    } else {
      masked[key] = data[key];
    }
  }
  return masked;
}

module.exports.loggerMiddleware = (req, res, next) => {
  const start = Date.now();
  const { method, originalUrl, body, query } = req;

  // Capture la réponse si erreur (status > 399) ou exception
  const defaultWrite = res.write;
  const defaultEnd = res.end;
  let responseBody = '';

  res.write = function (chunk, ...args) {
    responseBody += chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
    return defaultWrite.apply(res, [chunk, ...args]);
  };

  res.end = function (chunk, ...args) {
    if (chunk) responseBody += chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
    defaultEnd.apply(res, [chunk, ...args]);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Masque les champs sensibles du body
    const safeBody = maskSensitive(body);

    // Parse la réponse JSON si possible (pour logguer l'erreur serveur/API)
    let safeResp = {};
    if (responseBody && res.statusCode >= 400) {
      try { safeResp = JSON.parse(responseBody); } catch (e) { /* not JSON, ignore */ }
    }

    const logMsg = {
      timestamp: new Date().toISOString(),
      method,
      url: originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      user: req.user && req.user.email ? req.user.email : null,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      query,
      body: method === 'GET' ? undefined : safeBody,
      error: res.statusCode >= 400 ? (safeResp.error || safeResp.message || responseBody) : undefined
    };

    if (res.statusCode >= 400) {
      logger.error('[API ERROR]', logMsg);
    } else {
      logger.info('[API]', logMsg);
    }
  });

  next();
};
