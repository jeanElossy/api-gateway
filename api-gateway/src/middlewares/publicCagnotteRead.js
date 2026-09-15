"use strict";

/**
 * Lecture publique d'une cagnotte par son code — page de paiement invité.
 *
 * Décision du 2026-09-15 (validée par l'utilisateur) : tout `/api/v1/public/*`
 * exige une signature HMAC, qu'un navigateur ne peut pas produire sans exposer
 * le secret. La page `/pay/cagnotte/:code` ne pouvait donc pas se charger.
 *
 * On ouvre SANS signature exactement deux lectures, et rien d'autre :
 *
 *   GET /api/v1/public/cagnottes/by-code/:code
 *   GET /api/v1/public/cagnottes/by-code/:code/quote
 *
 * Garde-fous :
 *   - méthode GET/HEAD seulement, chemin EXACT (caractères du code limités :
 *     ni `/`, ni `%`, ni `.` — pas de traversée ni de chemin encodé) ;
 *   - limite de débit dédiée, par adresse, en plus de la limite publique ;
 *   - aucun identifiant de l'appelant n'est relayé (`Authorization`, cookies,
 *     jeton interne) : le backend reçoit une requête anonyme ;
 *   - le code `CAG-` porte 40 bits d'aléa : à 30 lectures par minute,
 *     l'énumération est hors de portée. La vue servie est la vue PUBLIQUE
 *     (cagnotte privée : ni description ni participants).
 *
 * Tout autre chemin sous `/api/v1/public/cagnottes` continue vers la
 * vérification de signature, inchangée.
 */

const CODE = "[A-Za-z0-9-]{3,64}";
const PUBLIC_CAGNOTTE_READ = new RegExp(`^/cagnottes/by-code/${CODE}(/quote)?/?$`);

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 30;

/** Ce couple méthode + chemin (relatif à `/api/v1/public`) est-il une lecture ouverte ? */
function isPublicCagnotteRead(method, path) {
  const m = String(method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return PUBLIC_CAGNOTTE_READ.test(String(path || ""));
}

/** Retire tout ce qui identifierait l'appelant auprès du backend. */
function stripCallerCredentials(req) {
  for (const header of ["authorization", "cookie", "x-internal-token", "x-gateway-token"]) {
    delete req.headers[header];
  }
}

/** Paramètres de la limite dédiée, avec des valeurs par défaut prudentes. */
function publicCagnotteLimits(rateLimitConfig = {}) {
  const windowMs = Number(rateLimitConfig?.windowMs);
  const max = Number(rateLimitConfig?.max);

  return {
    windowMs: Number.isFinite(windowMs) && windowMs >= 1000 ? windowMs : DEFAULT_WINDOW_MS,
    max: Number.isFinite(max) && max >= 1 ? max : DEFAULT_MAX,
  };
}

/**
 * @param {{proxy: Function|null, limiter: Function, setCors: Function}} deps
 *   `proxy` — le proxy vers le backend principal (null s'il n'est pas configuré).
 */
function makePublicCagnotteRead({ proxy, limiter, setCors }) {
  return function publicCagnotteRead(req, res, next) {
    if (!isPublicCagnotteRead(req.method, req.path)) return next();

    if (!proxy) {
      if (typeof setCors === "function") setCors(req, res);
      return res.status(503).json({
        success: false,
        code: "PRINCIPAL_UNAVAILABLE",
        message: "Service de cagnotte indisponible pour le moment.",
      });
    }

    stripCallerCredentials(req);
    return limiter(req, res, () => proxy(req, res, next));
  };
}

module.exports = {
  isPublicCagnotteRead,
  stripCallerCredentials,
  publicCagnotteLimits,
  makePublicCagnotteRead,
};
