// src/middlewares/auth.js

const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUsersConnection } = require('../db');
const getUserModel = require('../models/userModel');
const logger = require('../logger'); // Ajoute ton logger centralisé

// À implémenter : blacklist réelle si besoin
const isTokenBlacklisted = async (token) => {
  // Ex: vérification Redis/Mongo ou autre système
  return false;
};

const authMiddleware = async (req, res, next) => {
  try {
    // Authentification interne microservice
    const internalToken = req.headers['x-internal-token'];
    if (internalToken && internalToken === config.internalToken) {
      req.user = { system: true, role: 'internal-service' };
      return next();
    }

    // Authentification JWT utilisateur/admin
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentification requise' });
    }
    const token = authHeader.split(' ')[1];

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ success: false, error: 'Token révoqué. Merci de vous reconnecter.' });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, {
        algorithms: ['HS256', 'HS512'],
      });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, error: 'Session expirée, reconnectez-vous.' });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({ success: false, error: 'Token JWT invalide.' });
      }
      throw err;
    }

    if (!payload || !payload.id) {
      return res.status(401).json({ success: false, error: 'Token invalide' });
    }

    // Connexion DB utilisateurs (pool multi-connexion)
    const usersConn = getUsersConnection();
    const User = getUserModel(usersConn);

    // Recherche l'utilisateur par ID du token
    const user = await User.findById(payload.id);

    if (!user) {
      return res.status(401).json({ success: false, error: "Utilisateur introuvable" });
    }

    // Place le user dans req.user, plain object pour compatibilité partout
    req.user = user.toObject ? user.toObject() : user;

    next();

  } catch (err) {
    logger?.error
      ? logger.error('[AUTH] Erreur middleware:', err)
      : console.error('[AUTH] Erreur middleware:', err);

    return res.status(401).json({ success: false, error: 'Accès refusé' });
  }
};

module.exports = { authMiddleware };
