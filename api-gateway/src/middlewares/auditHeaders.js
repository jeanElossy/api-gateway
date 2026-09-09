// /src/middlewares/auditHeaders.js
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../logger');

module.exports = function auditHeaders(req, res, next) {
  // Assurer un request ID unique
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();

  // Si user connu, ajouter x-user-id et x-session-id
  if (req.user) {
    req.headers['x-user-id'] = (req.user._id || req.user.id)?.toString() || '';
    req.headers['x-session-id'] = req.user.sessionId || '';
  }

  /**
   * ⚠️ CETTE LIGNE FABRIQUAIT UN JETON INTERNE VALIDE — RETIRÉE LE 2026-09-03.
   *
   *     req.headers['x-internal-token'] = config.internalToken || '';
   *
   * Elle écrivait le secret d'autorisation interne dans la requête ENTRANTE,
   * sans condition, pour TOUTE requête traversant la passerelle. Les routes
   * NATIVES montées ensuite le relisaient comme s'il venait de l'appelant.
   *
   * ── La chaîne complète, telle qu'elle s'exécutait ─────────────────────────
   *
   *   1. `app.js:1144` — la barrière d'authentification, en mode observation
   *      (`AUTH_BARRIER_STRICT=false` par défaut), laisse passer tout
   *      `/api/v1/*` SANS appeler `authMiddleware`. `req.user` reste indéfini.
   *   2. `app.js:1195` — ce middleware pose `x-internal-token`.
   *   3. `app.js:1336` → `routes/fxRules.js:12` lit cet en-tête, le compare au
   *      `GATEWAY_INTERNAL_TOKEN` attendu — c'est le même — et `return next()`.
   *      `requireAdmin` n'est JAMAIS atteint.
   *   4. `POST/PUT/PATCH/DELETE /api/v1/fx-rules` s'exécute.
   *
   * Résultat : n'importe qui, sans aucun identifiant, écrivait les règles de
   * change et les barèmes de frais (`routes/fees.js:16`, `app.js:1307`) — la
   * frontière de tarification, premier terme de l'ordre de priorité du projet.
   * Le même contournement privait d'effet `validateInternalToken` sur les
   * routes internes (`app.js:1257-1258`) et `routes/transactions.js:91`.
   *
   * `AUTH_BARRIER_STRICT=true` ne l'aurait PAS refermé : ce middleware
   * s'exécute aussi pour un utilisateur authentifié non-admin, qui gardait donc
   * l'écriture complète sur les barèmes.
   *
   * ── Pourquoi la suppression ne casse rien ────────────────────────────────
   *
   * Le proxy pose DÉJÀ le jeton lui-même, sur la requête SORTANTE, là où c'est
   * sa place : `app.js:843-846` et `:928-932`, via `proxyReq.setHeader` avec
   * `config.principalInternalToken`.
   *
   * Et c'est le BON jeton : cette ligne posait `config.internalToken` — celui
   * de la passerelle — là où le backend principal attend
   * `principalInternalToken`. Elle ne servait donc même pas le proxy ; elle ne
   * servait que le contournement.
   *
   * Les appelants internes légitimes (Tx Core → passerelle) envoient leur vrai
   * `x-internal-token` et continuent de passer. Les administrateurs passent
   * désormais par `requireAdmin`, ce qui était l'intention d'origine.
   *
   * ⚠️ NE PAS RÉTABLIR. Un secret d'autorisation ne s'écrit jamais dans une
   * requête entrante : la frontière entre « ce que l'appelant a présenté » et
   * « ce que nous ajoutons pour l'aval » doit rester nette.
   */

  // Debug temporaire pour vérifier forwarding token
  try {
    const authPreview = req.headers.authorization
      ? String(req.headers.authorization).slice(0, 12)
      : null;
    logger.debug('[Middleware][AUDIT HEADERS] Forwarding headers', {
      authPreview,
      internalTokenPresent: !!req.headers['x-internal-token'], // tel que REÇU
      requestId: req.headers['x-request-id'],
      userId: req.headers['x-user-id'] || null,
      sessionId: req.headers['x-session-id'] || null,
      path: req.path,
    });
  } catch (e) {
    // noop, logging failure ne doit pas bloquer
  }

  next();
};
