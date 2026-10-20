"use strict";

/**
 * Désinscription des e-mails MARKETING — relais SANS signature (2026-10-20).
 *
 * Défaut trouvé le 2026-10-20 : le lien de désinscription de chaque e-mail
 * marketing (`<API>/api/v1/public/email/unsubscribe?t=…`, posé par le backend
 * `services/notifications/unsubscribe.js`) tombait sur la vérification de
 * signature HMAC de `/api/v1/public/*`. Ni un navigateur ni Gmail / Yahoo
 * (POST « List-Unsubscribe=One-Click », RFC 8058) ne peuvent la produire :
 * la désinscription — une obligation légale (LCAP au Canada) et une exigence
 * de Gmail pour les envois de masse — répondait 401.
 *
 * On ouvre exactement, et rien d'autre :
 *
 *   GET  /api/v1/public/email/unsubscribe   page de confirmation (n'écrit rien)
 *   HEAD /api/v1/public/email/unsubscribe
 *   POST /api/v1/public/email/unsubscribe   désinscrit (bouton ou un clic)
 *
 * Même garde-fous que la page invité (`publicCagnotteRead.js`) : chemin exact,
 * limite dédiée par adresse, aucun identifiant de l'appelant relayé. L'autorité
 * reste le jeton HMAC du lien, vérifié par le backend ; il ne permet QUE de se
 * désinscrire.
 */

const { stripCallerCredentials } = require("./publicCagnotteRead");

const PATH = /^\/email\/unsubscribe\/?$/;
const METHODS = new Set(["GET", "HEAD", "POST"]);

/** Ce couple méthode + chemin (relatif à `/api/v1/public`) est-il la désinscription ? */
function isPublicEmailUnsubscribe(method, path) {
  return METHODS.has(String(method || "").toUpperCase()) && PATH.test(String(path || ""));
}

/**
 * @param {{proxy: Function|null, limiter: Function, setCors: Function}} deps
 */
function makePublicEmailUnsubscribe({ proxy, limiter, setCors }) {
  return function publicEmailUnsubscribe(req, res, next) {
    if (!isPublicEmailUnsubscribe(req.method, req.path)) return next();

    if (!proxy) {
      if (typeof setCors === "function") setCors(req, res);
      return res.status(503).json({
        success: false,
        code: "PRINCIPAL_UNAVAILABLE",
        message: "Désinscription momentanément indisponible. Réessayez dans un instant.",
      });
    }

    stripCallerCredentials(req);
    return limiter(req, res, () => proxy(req, res, next));
  };
}

module.exports = { isPublicEmailUnsubscribe, makePublicEmailUnsubscribe };
