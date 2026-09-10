// src/server.js

require('dotenv').config();
const app = require('./app');
const config = require('./config');
const { connectToGatewayDB } = require('./db');
const logger = require('./logger');

// Fonction d'init globale (DB puis serveur Express)
(async () => {
  try {
    // 1️⃣ Connexion à la base MongoDB "api-gateway"
    await connectToGatewayDB();

    /**
     * ⚠️ LA CONNEXION À LA BASE DES UTILISATEURS N'EST PLUS OUVERTE — 2026-09-10.
     *
     * Elle l'était à chaque démarrage, et depuis la fusion de l'AML **plus
     * aucun code du bord ne la lisait**. Il restait une connexion ouverte en
     * permanence, un pool à maintenir, des identifiants de la base des
     * utilisateurs présents dans l'environnement de la surface la plus exposée
     * d'Internet — et un `/health` qui annonçait fièrement son état.
     *
     * C'est le dernier morceau de ce que « le bord ne détient aucune base »
     * veut dire : la passerelle vérifie une signature de jeton et relaie. Elle
     * n'a plus besoin de savoir qu'une base d'utilisateurs existe.
     *
     * ⚠️ `MONGO_URI_USERS` peut être RETIRÉE de l'environnement de ce service —
     * c'est une action d'exploitation, à faire après le déploiement.
     *
     * Verrouillé par `test/security/gatewayIsStateless.test.js`.
     */

    // La connexion nécessaire est ouverte : /readyz peut passer au vert.
    app.get("readiness")?.markStarted();

    // 3️⃣ Démarrage du serveur Express
    const PORT = config.port || 4000;
    const server = app.listen(PORT, () => {
      logger.info(
        `[Gateway] API listening on port ${PORT} (${config.nodeEnv})`
      );
    });

    /**
     * ARRÊT PROGRESSIF.
     *
     * `/readyz` bascule en 503 AVANT la fermeture : le répartiteur retire
     * l'instance de la rotation pendant que les requêtes en cours se terminent.
     * Sans ce délai, chaque redéploiement coupe des requêtes en vol — sur la
     * passerelle, ce sont des appels de paiement interrompus côté mobile.
     */
    const DRAIN_DELAY_MS = Number(process.env.DRAIN_DELAY_MS || 5000);
    let shuttingDown = false;

    const shutdown = async (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;

      logger.info(`[Gateway] Arrêt demandé (${sig}) — vidage en cours`);

      try {
        app.get("readiness")?.beginDraining();
        await new Promise((r) => setTimeout(r, DRAIN_DELAY_MS));
      } catch (e) {
        logger.error(`[Gateway] Erreur pendant le vidage: ${e?.message || e}`);
      }

      try {
        await new Promise((resolve) => server.close(resolve));
      } catch (e) {
        logger.error(`[Gateway] Erreur fermeture HTTP: ${e?.message || e}`);
      }

      process.exit(0);
    };

    ["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => shutdown(sig)));

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
      logger.error(
        '[Gateway] Unhandled Rejection at:',
        promise,
        'reason:',
        reason
      );
      process.exit(1);
    });

    /**
     * ========================================================================
     * IL Y AVAIT ICI UN SECOND GESTIONNAIRE `SIGTERM` — RETIRÉ
     * ========================================================================
     *
     * Un `process.on('SIGTERM', …)` supplémentaire fermait le serveur
     * IMMÉDIATEMENT et appelait `process.exit(0)`, en plus du `shutdown`
     * enregistré plus haut.
     *
     * Node exécute TOUS les gestionnaires d'un même signal, dans l'ordre
     * d'enregistrement. Celui-ci partait donc en parallèle du vidage de 5 s —
     * et son `process.exit(0)` pouvait tuer le processus AVANT que `shutdown`
     * ait fini d'attendre. Autrement dit : le second gestionnaire écourtait
     * exactement la garantie que le premier existe pour tenir.
     *
     * L'effet ne se voyait qu'au redéploiement, sous forme de requêtes de
     * paiement coupées en vol côté mobile — un symptôme qu'on n'attribue
     * jamais spontanément à un gestionnaire de signal en double.
     *
     * ⚠️ Ne pas « rajouter un log d'arrêt » ici. `shutdown` en journalise déjà
     * un (`Arrêt demandé (SIGTERM) — vidage en cours`) ; un second
     * gestionnaire, même purement informatif, est un `process.exit` de plus qui
     * attend d'être écrit.
     */
  } catch (err) {
    logger.error('[Gateway] Erreur fatale au démarrage :', err);
    process.exit(1);
  }
})();
