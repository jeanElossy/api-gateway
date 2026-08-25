const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

let usersConnection = null; // Connexion secondaire (users)

/**
 * OPTIONS DE CONNEXION — POURQUOI ELLES NE PEUVENT PAS RESTER IMPLICITES
 * ============================================================================
 *
 * Les deux connexions étaient ouvertes sans aucun second argument. Le pilote
 * appliquait donc ses défauts, dont `serverSelectionTimeoutMS: 30000`.
 *
 * Trente secondes, sur une passerelle, ce n'est pas un délai : c'est une panne.
 * La passerelle est la porte d'entrée de tout le trafic mobile et web ; une
 * indisponibilité passagère de MongoDB — bascule de réplique, micro-coupure
 * réseau, maintenance Atlas — y suspendait chaque requête pendant trente
 * secondes au lieu d'échouer vite. Le temps que la première vague expire, les
 * suivantes se sont empilées derrière elle, et la saturation se propage vers
 * l'amont alors même que Mongo est déjà revenu.
 *
 * Une passerelle doit échouer vite et dire pourquoi. On s'aligne donc sur
 * Tx-Core (`api-paynoval/src/config/db.js`), qui retient 8 s : assez pour
 * absorber une élection de réplique, trop peu pour immobiliser un client.
 *
 * ⚠️ `maxPoolSize` est posé explicitement **à la valeur que le pilote
 * appliquait déjà** (100). Ce n'est pas un réglage, c'est une mise en lumière :
 * le nombre était invisible alors qu'il détermine à la fois la concurrence par
 * instance et le nombre de connexions ouvertes contre Atlas quand on multiplie
 * les instances. Le dimensionner suppose des mesures que nous n'avons pas
 * encore — c'est la phase H qui tranchera. D'ici là, la variable
 * d'environnement permet de l'ajuster sans redéploiement.
 */
function buildMongooseOpts() {
  return {
    serverSelectionTimeoutMS: Number(
      process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 8000
    ),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 8000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),

    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 100),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 0),

    heartbeatFrequencyMS: Number(process.env.MONGO_HEARTBEAT_MS || 10000),
    retryWrites: true,
  };
}

async function connectToGatewayDB() {
  const uri = config.dbUris.gateway;
  if (!uri) {
    logger.error('[DB] MONGO_URI_GATEWAY manquant dans la config/env');
    process.exit(1);
  }

  const opts = buildMongooseOpts();

  try {
    await mongoose.connect(uri, opts);
    logger.info('[DB] Connexion MongoDB Gateway établie', {
      serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS,
      maxPoolSize: opts.maxPoolSize,
    });
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
    /**
     * Pas de `await` ici : `createConnection` rend la connexion immédiatement et
     * se connecte en tâche de fond. Les mêmes options s'appliquent — sans elles,
     * cette seconde connexion gardait les trente secondes de défaut alors que la
     * première venait d'en être débarrassée.
     */
    usersConnection = mongoose.createConnection(uri, buildMongooseOpts());
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
  getUsersConnection: () => usersConnection,
  buildMongooseOpts,
};
