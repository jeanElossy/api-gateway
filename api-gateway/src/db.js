// src/db.js

const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

/**
 * Connexion à la base MongoDB "gateway".
 */
async function connectToGatewayDB() {
  const uri = config.dbUris.gateway;
  if (!uri) {
    logger.error('[DB] MONGO_URI_GATEWAY manquant dans la config/env');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info(`[DB] Connexion MongoDB Gateway établie`);
  } catch (err) {
    logger.error('[DB] Erreur de connexion MongoDB Gateway :', err);
    process.exit(1);
  }

  mongoose.connection.on('disconnected', () => {
    logger.warn('[DB] Déconnecté de MongoDB Gateway');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('[DB] Reconnecté à MongoDB Gateway');
  });
}

module.exports = {
  connectToGatewayDB,
  // Plus tard : exporte d'autres connecteurs si tu veux du multi-db (ex: connectToUsersDB)
};
