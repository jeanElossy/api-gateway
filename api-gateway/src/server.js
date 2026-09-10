// src/server.js

require('dotenv').config();
const app = require('./app');
const config = require('./config');
const logger = require('./logger');

// Fonction d'init globale (DB puis serveur Express)
(async () => {
  try {
    /**
     * ════════════════════════════════════════════════════════════════════════
     * LA PASSERELLE N'OUVRE PLUS AUCUNE BASE — 2026-09-10
     * ════════════════════════════════════════════════════════════════════════
     *
     * Deux connexions partaient d'ici. La première, vers la base des
     * utilisateurs, a été retirée plus tôt le même jour : depuis la fusion de
     * l'AML dans Tx-Core, plus aucun code du bord ne la lisait.
     *
     * La seconde, `connectToGatewayDB()`, vient de partir pour la même raison.
     * Mesuré sur l'ensemble du dépôt avant de la retirer :
     *
     *     modèles déclarés     0        (`src/models/` est vide)
     *     collections lues     0
     *     requêtes émises      0
     *
     * Le dernier lecteur était `TrustedDepositNumber`, parti dans Tx-Core avec
     * la décision de confiance des numéros de dépôt.
     *
     * ── Ce que la connexion coûtait, elle qui ne servait plus ───────────────
     *
     *   · `process.exit(1)` si la base était injoignable : une panne Atlas sur
     *     une base que personne ne lit empêchait le bord de démarrer ;
     *   · `readiness required: ["main"]` : elle le sortait de la rotation ;
     *   · huit préfixes de routes — tous de purs relais vers Tx-Core —
     *     refusaient en 500 tant que `readyState !== 1`. La tarification
     *     tombait à cause d'une base qu'elle n'interroge pas.
     *
     * Le bord fait du TLS, du routage, de la vérification de signature de
     * jeton, de la limitation de débit et de la corrélation. Il ne possède
     * aucun domaine, donc aucune base.
     *
     * ⚠️ `MONGO_URI_GATEWAY` et `MONGO_URI_USERS` peuvent être RETIRÉES de
     * l'environnement de ce service. C'est une action d'exploitation : les
     * laisser n'a d'autre effet que de conserver deux secrets inutiles sur la
     * surface la plus exposée d'Internet.
     *
     * Verrouillé par `test/security/gatewayIsStateless.test.js`. Ne pas
     * rouvrir : le besoin qui le justifierait est le signe qu'un domaine est
     * en train de revenir au bord.
     */

    // Rien à attendre : /readyz peut passer au vert immédiatement.
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
