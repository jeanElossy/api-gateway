const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUsersConnection } = require('../db');
const getUserModel = require('../models/userModel');

const isTokenBlacklisted = async (token) => {
  return false;
};

const authMiddleware = async (req, res, next) => {
  try {
    const internalToken = req.headers['x-internal-token'];
    if (internalToken && internalToken === config.internalToken) {
      req.user = { system: true, role: 'internal-service' };
      return next();
    }
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentification requise' });
    }
    const token = authHeader.split(' ')[1];
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ success: false, error: 'Token révoqué. Merci de vous reconnecter.' });
    }
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256', 'HS512'],
    });
    if (!payload || !payload.id) {
      return res.status(401).json({ success: false, error: 'Token invalide' });
    }
    const usersConn = getUsersConnection();
    const User = getUserModel(usersConn);
    const user = await User.findById(payload.id);
    if (!user) {
      return res.status(401).json({ success: false, error: "Utilisateur introuvable" });
    }
    req.user = user;
    next();

  } catch (err) {
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
