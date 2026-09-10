"use strict";

/**
 * ============================================================================
 * RÉVOCATION DE JETON — CE QUI REMPLACE LE `User.findById()` DU BORD
 * ============================================================================
 *
 * ── Le défaut corrigé ───────────────────────────────────────────────────────
 *
 * La passerelle faisait un `User.findById()` sur SA PROPRE connexion Mongo à
 * CHAQUE requête authentifiée, pour relire `isBlocked`, `staffStatus` et
 * `accountStatus`.
 *
 * Trois problèmes, dans cet ordre de gravité :
 *
 *   1. **Une base de données sur la surface la plus exposée d'Internet.** Le
 *      bord est la seule porte que le monde entier peut frapper ; y placer les
 *      données utilisateur est le contraire de ce que font Stripe, PayPal et
 *      Adyen, qui posent une frontière réseau entre « ce qui répond à
 *      Internet » et « ce qui sait quelque chose ».
 *   2. **Un aller-retour base par requête**, sur le chemin de TOUTES les
 *      requêtes, y compris celles qui ne font que relayer.
 *   3. **Une duplication du contrôle.** Le backend principal fait déjà
 *      exactement ces vérifications dans son `protect` — et il les fait mieux,
 *      puisqu'il possède la donnée. Deux implémentations du même contrôle
 *      divergent toujours ; celle du bord travaillait sur une réplique qu'elle
 *      ne possédait pas.
 *
 * ── Ce que fait un bord, à la place ─────────────────────────────────────────
 *
 * Il VÉRIFIE une signature. C'est tout ce qu'un jeton permet d'affirmer sans
 * aller voir ailleurs. Le rôle, l'identité et le type de compte sont déjà dans
 * les revendications émises par le backend (`signAccessToken`).
 *
 * Reste une seule chose qu'une signature ne peut pas dire : « ce compte a-t-il
 * été bloqué DEPUIS l'émission ? ». C'est l'objet de ce module.
 *
 * ── Une DATE, et non un booléen ─────────────────────────────────────────────
 *
 * La clé `authrev:<userId>` porte un horodatage en secondes. Un jeton dont le
 * `iat` est ANTÉRIEUR à cette date est refusé.
 *
 * C'est plus utile qu'un drapeau « bloqué » :
 *   · débloquer un compte n'oblige pas à effacer la clé — les anciens jetons
 *     restent morts, les nouveaux passent ;
 *   · « déconnecter partout » s'exprime avec le même mécanisme ;
 *   · la clé porte un TTL égal à la durée de vie maximale d'un jeton, donc elle
 *     s'efface d'elle-même quand plus aucun jeton concerné ne peut exister
 *     (invariant A6 : aucune clé Redis sans expiration).
 *
 * ── ⚠️ POSTURE EN CAS DE PANNE REDIS — ELLE N'EST PAS LA MÊME POUR TOUS ─────
 *
 * Échouer en fermeture pour tout le monde transformerait une panne de cache en
 * panne d'authentification totale : le remède serait pire que le mal, et sur un
 * service de paiement une indisponibilité générale est elle-même un incident.
 *
 * Échouer en ouverture pour tout le monde laisserait un ADMINISTRATEUR
 * fraîchement suspendu garder ses droits jusqu'à l'expiration de son jeton.
 *
 * On tranche donc par le rayon d'impact, et on le dit :
 *
 *   · rôles STAFF (admin, superadmin, support, compliance, security,
 *     fraud-analyst) → FERMETURE. Un état de révocation illisible pour un compte
 *     à privilèges est un refus. Ils sont peu nombreux ; leur verrouillage
 *     temporaire est acceptable, le contraire ne l'est pas.
 *   · utilisateurs ordinaires → OUVERTURE, avec journal d'erreur et métrique.
 *     Le filet reste la durée de vie du jeton — et surtout, les chemins qui
 *     déplacent de l'argent sont relayés vers des services qui, EUX, relisent
 *     l'utilisateur en base et refusent un compte bloqué.
 *
 * Autrement dit : la disparition de Redis dégrade la RÉACTIVITÉ de la
 * révocation pour les comptes ordinaires, elle n'ouvre aucun chemin d'argent.
 */

const logger = require("../logger");

/** Rôles dont la révocation échoue en FERMETURE. Voir l'en-tête. */
const ROLES_SENSIBLES = Object.freeze([
  "admin",
  "superadmin",
  "support",
  "compliance",
  "security",
  "fraud-analyst",
]);

const PREFIXE = "authrev:";

/**
 * Durée de vie de la marque de révocation.
 *
 * Doit couvrir la durée de vie maximale d'un jeton : au-delà, plus aucun jeton
 * émis avant la révocation ne peut encore être valide, donc la marque ne sert
 * plus à rien. Une marge est ajoutée pour absorber une dérive d'horloge.
 */
const TTL_SECONDES = Number(process.env.AUTH_REVOCATION_TTL_SEC || 26 * 3600);

let panneAnnoncee = false;

function client() {
  try {
    return require("./rateLimitStore").getClient();
  } catch {
    return null;
  }
}

function estRoleSensible(role) {
  return ROLES_SENSIBLES.includes(String(role || "").trim().toLowerCase());
}

/**
 * Le jeton a-t-il été révoqué ?
 *
 * @returns {Promise<{revoked: boolean, reason: string}>}
 */
async function estRevoque({ userId, issuedAtSeconds, role }) {
  const id = String(userId || "").trim();

  if (!id) return { revoked: true, reason: "NO_SUBJECT" };

  const redis = client();

  if (!redis) {
    /**
     * Redis non configuré n'est PAS une panne : c'est le mode « une seule
     * instance », déjà documenté pour la limitation de débit. On l'annonce une
     * fois, avec sa conséquence (règle B.6), et on applique la posture par
     * rôle.
     */
    if (!panneAnnoncee) {
      panneAnnoncee = true;
      logger.warn(
        "[auth] Redis absent — CONSÉQUENCE : la révocation immédiate de jeton " +
          "est inopérante. Un compte bloqué conserve ses droits sur les routes " +
          "NATIVES de la passerelle jusqu'à expiration de son jeton. Les rôles " +
          "à privilèges sont refusés par précaution ; les chemins d'argent, " +
          "relayés, restent contrôlés par les services qui possèdent la donnée."
      );
    }

    return estRoleSensible(role)
      ? { revoked: true, reason: "REVOCATION_STORE_UNAVAILABLE" }
      : { revoked: false, reason: "REVOCATION_STORE_ABSENT" };
  }

  try {
    const brut = await redis.get(`${PREFIXE}${id}`);

    if (!brut) return { revoked: false, reason: "" };

    const revoqueDepuis = Number(brut);
    const emisA = Number(issuedAtSeconds);

    if (!Number.isFinite(revoqueDepuis)) {
      /**
       * Une marque illisible ne se lit pas comme « pas de révocation ». On
       * l'assimile à une révocation : sur un contrôle de sécurité, une donnée
       * corrompue ferme (règle B.2).
       */
      return { revoked: true, reason: "REVOCATION_MARK_UNREADABLE" };
    }

    if (!Number.isFinite(emisA)) {
      /** Un jeton sans `iat` ne peut pas être daté, donc pas être innocenté. */
      return { revoked: true, reason: "TOKEN_WITHOUT_IAT" };
    }

    return emisA < revoqueDepuis
      ? { revoked: true, reason: "TOKEN_REVOKED" }
      : { revoked: false, reason: "" };
  } catch (err) {
    logger.error("[auth] lecture de la révocation impossible", {
      message: err?.message,
      sensible: estRoleSensible(role),
    });

    return estRoleSensible(role)
      ? { revoked: true, reason: "REVOCATION_STORE_UNAVAILABLE" }
      : { revoked: false, reason: "REVOCATION_STORE_ERROR" };
  }
}

module.exports = {
  estRevoque,
  estRoleSensible,
  ROLES_SENSIBLES,
  PREFIXE,
  TTL_SECONDES,
};
