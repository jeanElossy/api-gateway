// src/server.js

require('dotenv').config();
const app = require('./app');
const config = require('./config');
const { connectToGatewayDB, connectToUsersDB } = require('./db');
const logger = require('./logger');

// Fonction d'init globale (DB puis serveur Express)
(async () => {
  try {
    // 1️⃣ Connexion à la base MongoDB "api-gateway"
    await connectToGatewayDB();

    // 2️⃣ Connexion à la base MongoDB "users" (facultatif, selon besoin)
    // Si tu veux initialiser cette connexion à chaque démarrage (recommandé si utilisé)
    await connectToUsersDB();

    // 3️⃣ Démarrage du serveur Express
    const PORT = config.port || 4000;
    const server = app.listen(PORT, () => {
      logger.info(`[Gateway] API listening on port ${PORT} (${config.nodeEnv})`);
    });

    // 4️⃣ Gestion des erreurs serveur (port déjà utilisé, etc.)
    server.on('error', (err) => {
      logger.error(`[Gateway] Erreur serveur: ${err.message}`);
      process.exit(1);
    });

    // 5️⃣ Sécurité : catch des exceptions non gérées (anti-crash)
    process.on('uncaughtException', (err) => {
      logger.error('[Gateway] Uncaught Exception:', err);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('[Gateway] Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });

    // 6️⃣ (Optionnel) Log si stop manuel
    process.on('SIGTERM', () => {
      logger.info('[Gateway] SIGTERM reçu. Arrêt propre du serveur...');
      server.close(() => {
        logger.info('[Gateway] Serveur arrêté.');
        process.exit(0);
      });
    });

  } catch (err) {
    logger.error('[Gateway] Erreur fatale au démarrage :', err);
    process.exit(1);
  }
})();
