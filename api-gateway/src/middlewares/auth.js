// File: src/middlewares/auth.js
"use strict";

const jwt = require("jsonwebtoken");
const config = require("../config");
const { secureCompare } = require("../utils/secureCompare");
const logger = require("../logger");
const { estRevoque } = require("../services/tokenRevocation");

/*
 * `getUsersConnection` et `getUserModel` ne sont plus importés : la passerelle
 * n'ouvre plus la base des utilisateurs pour authentifier.
 *
 * C'est la disparition de ces deux symboles qui MESURE le correctif du
 * 2026-09-10 — tant qu'ils étaient là, le `findById()` par requête pouvait
 * revenir en une ligne. Voir `services/tokenRevocation.js` pour le raisonnement
 * complet, et `test/security/gatewayIsStateless.test.js` pour la garde.
 */
const { getVerificationKey, readKid } = require("../utils/jwtKeyring");

/**
 * Émetteur et audiences attendus — mêmes variables que celles employées à la
 * SIGNATURE par le backend principal (`controllers/authController.js:307-315`).
 * La passerelle vérifie ce que le backend écrit ; toute divergence ici rejette
 * des jetons valides.
 */
const JWT_ISSUER = String(process.env.JWT_ISSUER || "").trim();
const JWT_AUDIENCES = String(
  process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE || ""
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

/**
 * ⚠️ LE BOUCHON DE LISTE NOIRE A ÉTÉ RETIRÉ LE 2026-09-03.
 *
 * Il valait :
 *
 *     // À implémenter si besoin (redis / db blacklist)
 *     const isTokenBlacklisted = async (_token) => false;
 *
 * appelé plus bas avec un refus « Token révoqué » qui n'arrivait jamais.
 *
 * ── Pourquoi le retirer plutôt que l'implémenter ──────────────────────────
 *
 * 1. **La révocation existe déjà, et elle fonctionne.**
 *    `Device.sessionInvalidBefore` est comparé à `payload.iat` dans
 *    `paynoval-backend/middleware/authMiddleware.js:335-337`. Elle est branchée
 *    sur `POST /devices/:id/revoke-sessions` et, depuis le 2026-09-02, sur
 *    `changePassword` et `resetPassword`. Une seconde couche ne révoquerait
 *    rien de plus.
 *
 * 2. **Une liste noire en Redis heurterait l'invariant 1 du projet.** Redis
 *    n'est jamais source de vérité, et sa perte doit être sans conséquence. Ici
 *    la perte d'une clé ferait REDEVENIR VALIDE un jeton révoqué : un repli en
 *    ouverture sur une frontière de sécurité, exactement ce que la règle B.2
 *    interdit.
 *
 * 3. **Un contrôle qui rend toujours `false` est pire qu'un contrôle absent.**
 *    Le nom promettait une protection, le refus « Token révoqué » juste en
 *    dessous la rendait crédible, et un relecteur pressé cochait la case. C'est
 *    le même motif que la garde `typeof notifySecurityAlert === "function"`
 *    trouvée la veille dans le backend : du code rassurant qui ne s'exécute
 *    jamais.
 *
 * Si une révocation par jeton devient nécessaire un jour — pour couper un jeton
 * précis sans toucher aux autres sessions de l'appareil — elle devra être
 * DURABLE (Mongo), pas un cache. Et elle devra dire ce qu'elle fait quand son
 * magasin est indisponible.
 *
 * La révocation passe par `Device.sessionInvalidBefore`. Voir
 * `docs/security/DIAGNOSTIC.md` §3.b.
 */

/**
 * ✅ Limite l'auth interne aux routes internes uniquement
 * (évite qu'un INTERNAL_TOKEN permette d'appeler TOUT le gateway)
 */
const INTERNAL_ALLOWED_PREFIXES = [
  "/api/v1/internal",
  "/internal/transactions",
  "/api/v1/internal/transactions",

  // ✅ important: autorise uniquement la partie "internal" des transactions
  "/api/v1/transactions/internal",
];

function isInternalAllowedPath(req) {
  const p = String(req.path || "");
  return INTERNAL_ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || typeof authHeader !== "string") return null;

  const s = authHeader.trim();
  if (!s.toLowerCase().startsWith("bearer ")) return null;

  const token = s.slice(7).trim();
  if (!token || token.toLowerCase() === "null") return null;
  return token;
}

/** ✅ Rend le gateway compatible avec le token du principal */
function resolveUserIdFromPayload(p) {
  return (
    p?.id ||
    p?._id ||
    p?.sub ||
    p?.user?.id ||
    p?.user?._id ||
    p?.userId ||
    null
  );
}

/** ✅ Unifie la clé JWT (priorité env, fallback config) */
function getJwtSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.PRINCIPAL_JWT_SECRET ||
    config.jwtSecret ||
    ""
  );
}

const authMiddleware = async (req, res, next) => {
  try {
    // 1️⃣ Auth interne microservice (gateway -> services)
    // ✅ accepté seulement sur routes internes
    const internalToken =
      req.headers["x-internal-token"] ||
      req.headers["x_internal_token"] ||
      req.headers["x-internal"] ||
      null;

    const expectedInternal =
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      config.gatewayInternalToken ||
      config.internalToken ||
      "";

    if (
      internalToken &&
      expectedInternal &&
      secureCompare(String(internalToken).trim(), String(expectedInternal).trim()) &&
      isInternalAllowedPath(req)
    ) {
      req.user = { system: true, role: "internal-service" };
      logger?.debug?.("[AUTH] Auth interne acceptée via x-internal-token");
      return next();
    }

    // 2️⃣ Auth JWT utilisateur/admin
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentification requise",
      });
    }

    const secret = getJwtSecret();
    if (!secret) {
      logger?.error?.("[AUTH] JWT secret missing (JWT_SECRET/config.jwtSecret)");
      return res.status(500).json({
        success: false,
        error: "Configuration JWT manquante (gateway)",
      });
    }

    let payload;
    try {
      /**
       * ⚠️ `HS512` RETIRÉ, `issuer`/`audience` AJOUTÉS — 2026-09-02.
       *
       * Cette vérification acceptait `HS256` ET `HS512`. Or il n'existe qu'UN
       * émetteur de jetons utilisateur dans tout le système —
       * `paynoval-backend/controllers/authController.js:269` — et il signe en
       * `HS256`, explicitement. Personne n'émet de HS512.
       *
       * Accepter un algorithme que rien n'émet n'apporte aucune compatibilité :
       * cela élargit seulement ce qu'un attaquant peut présenter. La règle est
       * d'accepter exactement ce que l'on émet, et rien de plus.
       *
       * `issuer` et `audience` : le backend les POSE à la signature quand
       * `JWT_ISSUER` / `JWT_AUDIENCES` sont configurés, et rien ne les
       * vérifiait — ni ici, ni dans le middleware du backend. Des revendications
       * signées et jamais lues ne protègent de rien. La condition est
       * symétrique à celle de la signature : sans configuration, on ne vérifie
       * pas, sinon on rejetterait des jetons valides.
       */
      const verifyOpts = { algorithms: ["HS256"] };
      if (JWT_ISSUER) verifyOpts.issuer = JWT_ISSUER;
      if (JWT_AUDIENCES.length) verifyOpts.audience = JWT_AUDIENCES;

      /**
       * ⚠️ CLÉ CHOISIE PAR `kid` — POSÉ LE 2026-09-03.
       *
       * La passerelle vérifie ce que le backend signe. Depuis que celui-ci
       * signe avec un trousseau, elle doit savoir choisir la même clé : sans
       * cela, la première rotation refuserait tous les jetons ici.
       *
       * Un jeton sans `kid` retombe sur le secret hérité — la branche qui rend
       * le déploiement insensible.
       */
      const cle = getVerificationKey(readKid(token)) || secret;

      payload = jwt.verify(token, cle, verifyOpts);
    } catch (err) {
      if (err?.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          error: "Session expirée, reconnectez-vous.",
        });
      }
      if (err?.name === "JsonWebTokenError") {
        return res.status(401).json({
          success: false,
          error: "Token JWT invalide.",
        });
      }
      throw err;
    }

    const userId = resolveUserIdFromPayload(payload);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Token invalide (id/sub manquant)",
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * L'IDENTITÉ VIENT DES REVENDICATIONS, PLUS D'UNE LECTURE EN BASE
     * ══════════════════════════════════════════════════════════════════════
     *
     * Ce bloc faisait `User.findById(userId)` sur la connexion Mongo de la
     * passerelle, puis relisait `isBlocked`, `staffStatus` et `accountStatus`.
     *
     * Trois raisons de l'avoir retiré, par ordre de gravité :
     *
     *   1. il plaçait une base de données sur la surface la plus exposée
     *      d'Internet. Stripe, PayPal et Adyen posent tous une frontière réseau
     *      entre « ce qui répond à Internet » et « ce qui sait quelque chose » ;
     *   2. il ajoutait un aller-retour base à CHAQUE requête authentifiée, y
     *      compris celles qui ne font que relayer ;
     *   3. il DUPLIQUAIT un contrôle que le backend principal fait déjà dans
     *      son `protect`, et qu'il fait mieux puisqu'il possède la donnée. Deux
     *      implémentations du même contrôle divergent toujours.
     *
     * Le jeton porte déjà `id`, `email`, `role`, `userType`, `country`,
     * `currency`, `isSandbox` et `isReviewerAccount` (`signAccessToken` du
     * backend). Tout ce dont la passerelle a besoin pour router et autoriser.
     *
     * ⚠️ Ce que la signature ne peut PAS dire : « ce compte a-t-il été bloqué
     * depuis l'émission ? ». C'est le rôle de la marque de révocation, dont la
     * posture en cas de panne est détaillée dans `services/tokenRevocation.js`
     * — fermeture pour les rôles à privilèges, ouverture pour les autres, dont
     * les chemins d'argent restent contrôlés par les services propriétaires.
     */
    const role = String(payload.role || "").trim();

    const revocation = await estRevoque({
      userId,
      issuedAtSeconds: payload.iat,
      role,
    });

    if (revocation.revoked) {
      logger.warn?.("[AUTH] jeton refusé", {
        reason: revocation.reason,
        role: role || null,
      });

      return res.status(401).json({
        success: false,
        error: "Session invalide, reconnectez-vous.",
        code: revocation.reason,
      });
    }

    /**
     * `req.user` reste la forme attendue par le reste de la passerelle
     * (`_id`, `id`, `role`), pour qu'aucun appelant n'ait à changer. Ce qui
     * change, c'est la SOURCE : des revendications signées, plus une lecture.
     */
    req.user = {
      _id: userId,
      id: userId,
      email: payload.email || "",
      role,
      userType: payload.userType || "",
      country: payload.country || "",
      currency: payload.currency || "",
      isSandbox: payload.isSandbox === true,
      isReviewerAccount: payload.isReviewerAccount === true,
      deviceId: payload.did || null,
      /** Trace de provenance : utile en journal, et honnête sur la source. */
      __source: "jwt-claims",
    };

    return next();

  } catch (err) {
    logger?.error
      ? logger.error("[AUTH] Erreur middleware:", err)
      : console.error("[AUTH] Erreur middleware:", err);

    return res.status(401).json({
      success: false,
      error: "Accès refusé",
    });
  }
};

// Alias compat
const protect = authMiddleware;

module.exports = { authMiddleware, protect };
