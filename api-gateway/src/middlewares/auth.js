const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUsersConnection } = require('../db');           // Permet de récupérer la connexion secondaire "users"
const getUserModel = require('../models/userModel');       // Factory qui prend la connexion et retourne le modèle User

// 👉 Ici, branche la blacklist de tokens si tu utilises Redis/MongoDB pour les tokens révoqués
const isTokenBlacklisted = async (token) => {
  // Ex: requête vers Redis ou une collection MongoDB
  return false;
};

/**
 * Middleware d’authentification général
 * - Vérifie le JWT dans le header Authorization: Bearer xxx
 * - OU le token interne pour les communications microservices
 * - Charge l’utilisateur MongoDB complet en base "users"
 */
const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Vérification du token interne (pour communications inter-microservices)
    const internalToken = req.headers['x-internal-token'];
    if (internalToken && internalToken === config.internalToken) {
      req.user = { system: true, role: 'internal-service' };
      return next();
    }

    // 2️⃣ Vérification du JWT utilisateur classique dans le header
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentification requise' });
    }
    const token = authHeader.split(' ')[1];

    // 3️⃣ Vérifie la présence sur une blacklist (facultatif mais pro)
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ success: false, error: 'Token révoqué. Merci de vous reconnecter.' });
    }

    // 4️⃣ Vérification et décodage du JWT (HS256/HS512)
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256', 'HS512'],
    });

    // 5️⃣ Contrôle que le token a bien un champ id
    if (!payload || !payload.id) {
      return res.status(401).json({ success: false, error: 'Token invalide' });
    }

    // 6️⃣ Récupération du user complet en base MongoDB "users"
    const usersConn = getUsersConnection();           // Récupère la connexion secondaire
    const User = getUserModel(usersConn);             // Initialise le modèle User avec cette connexion
    const user = await User.findById(payload.id);     // Charge l'utilisateur complet

    if (!user) {
      return res.status(401).json({ success: false, error: "Utilisateur introuvable" });
    }

    req.user = user; // Place l'objet User Mongoose complet dans req.user pour les middlewares/contrôleurs suivants
    next();

  } catch (err) {
    // Gestion des erreurs JWT (expiration, altération, etc.)
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Session expirée, reconnectez-vous.' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, error: 'Token JWT invalide.' });
    }
    console.error('[AUTH] Erreur middleware:', err);
    res.status(401).json({ success: false, error: 'Accès refusé' });
  }
};

module.exports = { authMiddleware };
