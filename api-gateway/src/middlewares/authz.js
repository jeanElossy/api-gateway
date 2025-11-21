/**
 * Middleware pour exiger un rôle utilisateur précis
 * Si l'utilisateur est "user", on ne fait pas de vérification et on laisse passer
 */
const requireRole = (roles = []) => (req, res, next) => {
  const userRole = req.user?.role;

  console.log('User role:', userRole);

  if (!userRole) {
    return res.status(403).json({ success: false, error: "Accès interdit (non authentifié)" });
  }

  // Si l'utilisateur est un "user", on laisse passer
  if (userRole.toLowerCase() === 'user') {
    return next();
  }

  // Sinon, on vérifie si son rôle est dans la liste
  if (!roles.includes(userRole)) {
    return res.status(403).json({ success: false, error: "Accès interdit (rôle insuffisant)" });
  }

  next();
};

// Alias classiques
const requireAdmin = requireRole(['admin', 'superadmin']);
const requireSuperadmin = requireRole(['superadmin']);

module.exports = {
  requireRole,
  requireAdmin,
  requireSuperadmin,
};
