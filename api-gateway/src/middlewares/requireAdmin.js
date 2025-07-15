// src/middleware/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    return res.status(403).json({ success: false, message: 'Accès refusé (admin uniquement)' });
  }
  next();
};
