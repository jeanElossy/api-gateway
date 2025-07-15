// src/middlewares/gatewayAuth.js
module.exports = function gatewayAuth(req, res, next) {
  // On accepte uniquement les requêtes de la Gateway (token interne partagé, jamais public)
  if (req.headers['x-internal-token'] !== process.env.INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'Accès interdit. Gateway uniquement.' });
  }
  next();
};
