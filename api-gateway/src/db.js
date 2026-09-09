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

/**
 * Instrumente le pool de connexions d'une connexion Mongoose (§41).
 *
 * ⚠️ IL FAUT ATTENDRE LE `MongoClient`, PAS SEULEMENT L'APPEL À `connect`.
 * `conn.getClient()` rend `undefined` tant que le pilote ne l'a pas construit —
 * et `connectToUsersDB` n'attend justement rien (`createConnection` se connecte
 * en tâche de fond). S'abonner à rien produirait des jauges plates qu'on
 * prendrait pour un pool au repos, exactement le contresens que §41 doit
 * empêcher.
 *
 * On tente donc tout de suite si le client existe déjà, et on repasse sur
 * `connected` sinon. `trackPool` dédoublonne par identité de client : être
 * appelé deux fois (première connexion puis reconnexion) ne compte jamais un
 * événement deux fois.
 */
function attachPoolMetrics(conn, name) {
  const track = () => {
    try {
      const client = conn?.getClient?.();
      if (!client) return false;

      require('./services/mongoPoolMetrics').trackPool(client, name, { logger });
      return true;
    } catch (err) {
      // Une métrique ne doit JAMAIS empêcher une connexion à la base.
      logger.warn(
        `[metrics] pool Mongo « ${name} » non instrumenté : ${err?.message || err}`
      );
      return true; // inutile de réessayer sur chaque reconnexion
    }
  };

  if (track()) return;

  conn?.on?.('connected', track);
}

async function connectToGatewayDB() {
  const uri = config.dbUris.gateway;
  if (!uri) {
    logger.error('[DB] MONGO_URI_GATEWAY manquant dans la config/env');
    process.exit(1);
  }

  const opts = buildMongooseOpts();

  try {
    /**
     * Sur quelles données travaille-t-on ? (règle B.6, défaut A1)
     * Refuse un démarrage dont NODE_ENV contredit la base visée.
     */
    require("./utils/dbEnvironmentGuard").assertDatabaseEnvironment(uri, {
      label: "base Gateway",
      logger,
    });

    await mongoose.connect(uri, opts);
    attachPoolMetrics(mongoose.connection, 'gateway');
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
     * Sur quelles données travaille-t-on ? (règle B.6, défaut A1)
     *
     * La passerelle ouvre DEUX connexions vers DEUX bases distinctes. Vérifier
     * la première seulement ne prouve rien sur la seconde : le 2026-09-03, la
     * base Gateway était annoncée et celle des utilisateurs ne l'était pas.
     */
    require("./utils/dbEnvironmentGuard").assertDatabaseEnvironment(uri, {
      label: "base Users",
      logger,
    });

    /**
     * Pas de `await` ici : `createConnection` rend la connexion immédiatement et
     * se connecte en tâche de fond. Les mêmes options s'appliquent — sans elles,
     * cette seconde connexion gardait les trente secondes de défaut alors que la
     * première venait d'en être débarrassée.
     */
    usersConnection = mongoose.createConnection(uri, buildMongooseOpts());
    attachPoolMetrics(usersConnection, 'users');
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
