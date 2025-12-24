// File: api-gateway/src/middlewares/auth.js
'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUsersConnection } = require('../db');
const getUserModel = require('../models/userModel');
const logger = require('../logger');

// À implémenter : blacklist réelle si besoin
const isTokenBlacklisted = async (_token) => {
  return false;
};

const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Authentification interne microservice (Gateway -> microservices, etc.)
    const internalToken = req.headers['x-internal-token'];

    // ✅ Support tokens possibles (évite mismatch entre envs)
    const expectedInternal =
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      config.internalToken ||
      '';

    if (internalToken && expectedInternal && internalToken === expectedInternal) {
      req.user = { system: true, role: 'internal-service' };
      logger?.debug?.('[AUTH] Auth interne acceptée via x-internal-token');
      return next();
    }

    // 2️⃣ Authentification JWT utilisateur/admin
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise',
      });
    }

    const token = authHeader.split(' ')[1]?.trim();

    if (!token || token.toLowerCase() === 'null') {
      return res.status(401).json({
        success: false,
        error: 'Token manquant ou invalide',
      });
    }

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({
        success: false,
        error: 'Token révoqué. Merci de vous reconnecter.',
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, {
        algorithms: ['HS256', 'HS512'],
      });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Session expirée, reconnectez-vous.',
        });
      }
      if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          error: 'Token JWT invalide.',
        });
      }
      throw err;
    }

    if (!payload || !payload.id) {
      return res.status(401).json({
        success: false,
        error: 'Token invalide (payload incomplet)',
      });
    }

    // Connexion DB utilisateurs
    const usersConn = getUsersConnection();
    const User = getUserModel(usersConn);

    const user = await User.findById(payload.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Utilisateur introuvable',
      });
    }

    req.user = user.toObject ? user.toObject() : user;

    return next();
  } catch (err) {
    logger?.error
      ? logger.error('[AUTH] Erreur middleware:', err)
      : console.error('[AUTH] Erreur middleware:', err);

    return res.status(401).json({
      success: false,
      error: 'Accès refusé',
    });
  }
};

// ALIAS pour compatibilité (protect == authMiddleware)
const protect = authMiddleware;

module.exports = { authMiddleware, protect };
