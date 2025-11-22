// /src/middlewares/auditHeaders.js
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../logger');

module.exports = function auditHeaders(req, res, next) {
  // Assurer un request ID unique
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();

  // Si user connu, ajouter x-user-id et x-session-id
  if (req.user) {
    req.headers['x-user-id'] = (req.user._id || req.user.id)?.toString() || '';
    req.headers['x-session-id'] = req.user.sessionId || '';
  }

  // Toujours ajouter token interne pour microservices
  req.headers['x-internal-token'] = config.internalToken || '';

  // Debug temporaire pour vérifier forwarding token
  try {
    const authPreview = req.headers.authorization
      ? String(req.headers.authorization).slice(0, 12)
      : null;
    logger.debug('[Middleware][AUDIT HEADERS] Forwarding headers', {
      authPreview,
      internalTokenPresent: !!req.headers['x-internal-token'],
      requestId: req.headers['x-request-id'],
      userId: req.headers['x-user-id'] || null,
      sessionId: req.headers['x-session-id'] || null,
      path: req.path,
    });
  } catch (e) {
    // noop, logging failure ne doit pas bloquer
  }

  next();
};
