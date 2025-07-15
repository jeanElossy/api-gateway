// /src/middlewares/auditHeaders.js
const { v4: uuidv4 } = require('uuid');
module.exports = function auditHeaders(req, res, next) {
  // Propagation request id unique (si pas déjà là)
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
  // Si user connu, tu ajoutes
  if (req.user && req.user._id) {
    req.headers['x-user-id'] = req.user._id.toString();
    req.headers['x-session-id'] = req.user.sessionId || '';
  }
  next();
};
