// src/middlewares/authz.js
/**
 * Middleware pour exiger un rôle utilisateur précis (ex: 'admin', 'superadmin')
 * Utilisation : requireRole(['admin', 'superadmin'])
 */
module.exports.requireRole = (roles = []) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, error: "Accès interdit (rôle insuffisant)" });
  }
  next();
};
