// File: src/middlewares/authz.js
"use strict";

/**
 * @param {string[]} roles   Rôles autorisés (vide = tout rôle authentifié).
 * @param {object}   options
 * @param {boolean}  options.allowInternal  Autorise le pseudo-rôle
 *   `internal-service` (auth par x-internal-token). Doit être demandé
 *   EXPLICITEMENT route par route.
 *
 * ⚠️ Sécurité : auparavant `internal-service` passait TOUS les contrôles de
 * rôle, sur toutes les routes. Le token interne est aujourd'hui limité aux
 * préfixes internes (cf. middlewares/auth.js), mais toute route acceptant ce
 * token héritait d'un contournement total. L'autorisation est désormais opt-in.
 */
const requireRole = (roles = [], options = {}) => (req, res, next) => {
  const role = String(req.user?.role || "").toLowerCase();

  if (!role) {
    return res.status(403).json({ success: false, error: "Accès interdit (non authentifié)" });
  }

  if (role === "internal-service") {
    if (options.allowInternal === true) return next();

    return res.status(403).json({
      success: false,
      error: "Accès interdit (appel interne non autorisé sur cette route)",
    });
  }

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
