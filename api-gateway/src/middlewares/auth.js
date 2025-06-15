const jwt = require('jsonwebtoken');
const config = require('../config');

// 👉 À toi d’implémenter la blacklist des tokens révoqués, ou de brancher sur ta DB/Redis si besoin
const isTokenBlacklisted = async (token) => {
  // Ex: requête vers Redis ou une collection MongoDB
  return false;
};

/**
 * Middleware d’authentification général
 * - Vérifie le JWT dans le header Authorization: Bearer xxx
 * - OU le token interne pour les communications microservices
 */
const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Vérification du token interne (entre services, pour forwarding)
    const internalToken = req.headers['x-internal-token'];
    if (internalToken && internalToken === config.internalToken) {
      req.user = { system: true, role: 'internal-service' };
      return next();
    }

    // 2️⃣ Vérification du JWT utilisateur classique
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Authentification requise' });
    }
    const token = authHeader.split(' ')[1];

    // 3️⃣ Vérifie la présence sur une blacklist (facultatif mais pro)
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ success: false, error: 'Token révoqué. Merci de vous reconnecter.' });
    }

    // 4️⃣ Vérification et décodage du JWT
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256', 'HS512'], // Adapte si tu changes d’algorithme
    });

    // 5️⃣ Contrôle du contenu du token (ex: exp, role, permissions, etc.)
    if (!payload || !payload.id) {
      return res.status(401).json({ success: false, error: 'Token invalide' });
    }

    req.user = payload; // Place l'utilisateur dans req.user pour les routes suivantes
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
