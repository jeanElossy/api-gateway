/**
 * Middleware pour exiger un rôle utilisateur précis (ex: 'admin', 'superadmin')
 * Utilisation : requireRole(['admin', 'superadmin'])
 */
const requireRole = (roles = []) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, error: "Accès interdit (rôle insuffisant)" });
  }
  next();
};

// Alias classiques utilisés partout
const requireAdmin = requireRole(['admin', 'superadmin']);
const requireSuperadmin = requireRole(['superadmin']);

module.exports = {
  requireRole,
  requireAdmin,
  requireSuperadmin,
};
