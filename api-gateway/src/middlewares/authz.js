// File: src/middlewares/authz.js
"use strict";

const requireRole = (roles = []) => (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();

  if (!role) {
    return res.status(403).json({ success: false, error: "Accès interdit (non authentifié)" });
  }

  // internal-service optionnel (si tu veux l’autoriser sur certaines routes)
  if (role === "internal-service") return next();

  // Si aucune contrainte de rôle => ok
  if (!Array.isArray(roles) || roles.length === 0) return next();

  const allowed = roles.map(r => String(r).toLowerCase());
  if (!allowed.includes(role)) {
    return res.status(403).json({ success: false, error: "Accès interdit (rôle insuffisant)" });
  }

  return next();
};

const requireAdmin = requireRole(["admin", "superadmin"]);
const requireSuperadmin = requireRole(["superadmin"]);

module.exports = { requireRole, requireAdmin, requireSuperadmin };
