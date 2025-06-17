// // src/db.js

// const mongoose = require('mongoose');
// const config = require('./config');
// const logger = require('./logger');

// let usersConnection = null; // Sera la connexion secondaire (users)

// /**
//  * Connexion à la base MongoDB "api-gateway"
//  * (connexion par défaut de mongoose)
//  */
// async function connectToGatewayDB() {
//   const uri = config.dbUris.gateway;
//   if (!uri) {
//     logger.error('[DB] MONGO_URI_GATEWAY manquant dans la config/env');
//     process.exit(1);
//   }
//   try {
//     await mongoose.connect(uri);
//     logger.info('[DB] Connexion MongoDB Gateway établie');
//   } catch (err) {
//     logger.error('[DB] Erreur de connexion MongoDB Gateway :', err);
//     process.exit(1);
//   }
//   mongoose.connection.on('disconnected', () => {
//     logger.warn('[DB] Déconnecté de MongoDB Gateway');
//   });
//   mongoose.connection.on('reconnected', () => {
//     logger.info('[DB] Reconnecté à MongoDB Gateway');
//   });
// }

// /**
//  * Connexion à la base MongoDB "users"
//  * (connexion indépendante, à utiliser pour des besoins spécifiques)
//  */
// async function connectToUsersDB() {
//   const uri = config.dbUris.users;
//   if (!uri) {
//     logger.error('[DB] MONGO_URI_USERS manquant dans la config/env');
//     process.exit(1);
//   }
//   try {
//     usersConnection = await mongoose.createConnection(uri);
//     logger.info('[DB] Connexion MongoDB Users établie');
//     // Tu peux retourner la connexion si besoin :
//     // return usersConnection;
//   } catch (err) {
//     logger.error('[DB] Erreur de connexion MongoDB Users :', err);
//     process.exit(1);
//   }
//   usersConnection.on('disconnected', () => {
//     logger.warn('[DB] Déconnecté de MongoDB Users');
//   });
//   usersConnection.on('reconnected', () => {
//     logger.info('[DB] Reconnecté à MongoDB Users');
//   });
// }

// // Exporte les connecteurs, et l'instance usersConnection si besoin ailleurs
// module.exports = {
//   connectToGatewayDB,
//   connectToUsersDB,
//   getUsersConnection: () => usersConnection
// };


const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

let usersConnection = null; // Connexion secondaire (users)

async function connectToGatewayDB() {
  const uri = config.dbUris.gateway;
  if (!uri) {
    logger.error('[DB] MONGO_URI_GATEWAY manquant dans la config/env');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    logger.info('[DB] Connexion MongoDB Gateway établie');
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

async function connectToUsersDB() {
  const uri = config.dbUris.users;
  if (!uri) {
    logger.error('[DB] MONGO_URI_USERS manquant dans la config/env');
    process.exit(1);
  }
  try {
    // ✅ Correction : remove "await", pas nécessaire ici car mongoose.createConnection retourne une connexion directe, la connection sera async en tâche de fond.
    usersConnection = mongoose.createConnection(uri);
    logger.info('[DB] Connexion MongoDB Users établie');
  } catch (err) {
    logger.error('[DB] Erreur de connexion MongoDB Users :', err);
    process.exit(1);
  }
  usersConnection.on('disconnected', () => {
    logger.warn('[DB] Déconnecté de MongoDB Users');
  });
  usersConnection.on('reconnected', () => {
    logger.info('[DB] Reconnecté à MongoDB Users');
  });
}

module.exports = {
  connectToGatewayDB,
  connectToUsersDB,
  getUsersConnection: () => usersConnection
};
