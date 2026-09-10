"use strict";

/**
 * ============================================================================
 * PLOMBERIE DE RELAIS — CE QUE LE BORD GARDE
 * ============================================================================
 *
 * ── Ce fichier portait DEUX choses, pas une ────────────────────────────────
 *
 * Son ancien nom — « Phone / Forward Headers / Deposit trust helpers » — le
 * disait sans qu'on l'entende : trois sujets pour un module.
 *
 *   · une DÉCISION : « ce numéro de dépôt est-il de confiance ? », qui lisait
 *     `TrustedDepositNumber` et refusait en 403 ;
 *   · de la PLOMBERIE : reconstruire les en-têtes sortants du proxy, dont la
 *     clé d'idempotence.
 *
 * La décision est partie dans TX Core le 2026-09-10
 * (`services/risk/depositPhoneTrust.js` + `middleware/requireTrustedDepositPhone`).
 * Un contrôle qui AUTORISE un mouvement d'argent appartient au service qui
 * déplace l'argent : sinon il suffit d'atteindre le moteur autrement pour s'en
 * affranchir.
 *
 * La plomberie reste. Elle n'a aucun sens ailleurs : le moteur ne proxifie
 * rien, il n'a pas d'en-têtes sortants à reconstruire.
 *
 * ⚠️ NE PAS RÉINTRODUIRE ICI DE LECTURE EN BASE NI DE DÉCISION MÉTIER.
 * Le bord fait du TLS, du routage, de la vérification de jeton, de la
 * limitation de débit et de la corrélation. Il ne possède aucun domaine.
 * `test/transactions/edgeHasNoDepositTrust.test.js` le vérifie.
 */

const crypto = require("crypto");

function reqAny(paths) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      return require(p);
    } catch {}
  }
  const e = new Error(`Module introuvable (paths tried): ${paths.join(", ")}`);
  e.status = 500;
  throw e;
}

const config = reqAny(["../../src/config", "../../config"]);







function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function safeUUID() {
  if (crypto && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {}
  }

  return (
    Date.now().toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

/**
 * En-têtes d'idempotence acceptés en entrée, dans l'ordre de priorité.
 *
 * Les deux noms sont ceux que `api-paynoval/src/utils/idempotencyKeys.js`
 * (`extractIdempotencyKey`) sait lire à l'autre bout. Toute divergence entre
 * ces deux listes rouvrirait le défaut que ce module vient de fermer.
 */
const IDEMPOTENCY_HEADERS = ["idempotency-key", "x-idempotency-key"];

/**
 * Retrouve la clé d'idempotence dans une requête entrante, quelle que soit la
 * casse employée par le client. Node normalise les en-têtes en minuscules, mais
 * `req.headers` peut avoir été reconstruit en amont (tests, proxys, adaptateurs)
 * sans cette garantie — on ne s'y fie donc pas.
 */
function pickIdempotencyHeader(req) {
  const headers = req?.headers || {};

  for (const attendu of IDEMPOTENCY_HEADERS) {
    for (const nom of Object.keys(headers)) {
      if (String(nom).toLowerCase() !== attendu) continue;

      const brut = headers[nom];
      const valeur = Array.isArray(brut) ? brut[0] : brut;
      const propre = String(valeur ?? "").trim();

      if (propre) return propre;
    }
  }

  return "";
}

/**
 * ============================================================================
 * LA CLÉ D'IDEMPOTENCE SE TRANSMET — SINON TOUTE LA CHAÎNE EST INERTE
 * ============================================================================
 *
 * Cette fonction ne RELAIE pas les en-têtes reçus : elle en RECONSTRUIT un jeu
 * complet. C'est délibéré — on ne veut pas voir un en-tête arbitraire du client
 * arriver sur un service interne. Mais la reconstruction avait un trou.
 *
 * ── Le défaut (mesuré le 2026-09-09) ────────────────────────────────────────
 *
 * `Idempotency-Key` ne figurait pas dans le jeu reconstruit. L'application
 * mobile ne l'envoie QUE dans l'en-tête (`payNoval-master/tools/api.js` :
 * `headers: { "Idempotency-Key": … }`, et le corps n'en porte aucune). La clé
 * était donc jetée ici, et TX Core n'en voyait jamais la couleur.
 *
 * La conséquence n'était pas « une protection en moins » mais TROIS, qui
 * tombaient ensemble :
 *
 *   1. `middleware/idempotency.js` ne trouvait aucune clé et laissait passer
 *      (`IDEMPOTENCY_REQUIRED` vaut `false`) — aucun enregistrement dans
 *      `idempotency_records`, donc aucune détection de rejeu ;
 *   2. `resolvePersistedIdempotencyKey()` rendait `undefined`, donc le champ
 *      `Transaction.idempotencyKey` restait ABSENT du document ;
 *   3. les deux index uniques partiels `{sender, idempotencyKey}` et
 *      `{userId, idempotencyKey}` portent un filtre
 *      `idempotencyKey: { $type: "string", $gt: "" }` : un document sans le
 *      champ en est EXCLU. Les index existaient et ne mordaient sur rien.
 *
 * Deux `/initiate` concurrents créaient donc deux transactions et RÉSERVAIENT
 * LES FONDS DEUX FOIS. C'est exactement le scénario que l'en-tête de
 * `api-paynoval/src/utils/idempotencyKeys.js` décrit comme fermé depuis le
 * 2026-09-03 : le correctif avait été posé du bon côté de la frontière, mais
 * rien ne traversait la frontière.
 *
 * ── Pourquoi la correction est ICI et pas dans les adaptateurs ──────────────
 *
 * Cinq appelants passent par cette fonction — `paynovalAdapter`,
 * `mobilemoneyAdapter`, `cardAdapter`, `orchestrator` et
 * `transactionOrchestratorByFlow`. Corriger chaque adaptateur aurait produit
 * cinq occasions d'en oublier un ; ici il n'y en a qu'une seule à tenir, et
 * c'est celle que `test/security/idempotencyHeaderForwarded.test.js` surveille.
 *
 * ── Pourquoi la propager aussi sur les chemins qui ne l'exploitent pas ──────
 *
 * `fetchOtpStatus` est un GET : la clé n'y sert à rien. On la transmet quand
 * même, parce que la règle « on relaie le contexte d'audit du client » est plus
 * sûre qu'une liste d'exceptions à maintenir. Un en-tête ignoré ne coûte rien ;
 * un en-tête oublié coûte une double réservation de fonds.
 *
 * ⚠️ On NORMALISE le nom en `idempotency-key` en sortie. TX Core accepte les
 * deux graphies, mais n'en émettre qu'une évite qu'un client envoyant les deux
 * variantes avec des valeurs différentes ne rende le comportement dépendant de
 * l'ordre d'itération des clés.
 */
function auditForwardHeaders(req) {
  const incomingAuth =
    req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== "bearer null" &&
    String(incomingAuth).trim().toLowerCase() !== "null";

  const reqId = req.headers["x-request-id"] || req.id || safeUUID();
  const userIdRaw = getUserId(req) || req.headers["x-user-id"] || "";
  const userId = String(userIdRaw || "");

  const internalToken =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  const idempotencyKey = pickIdempotencyHeader(req);

  const headers = {
    Accept: "application/json",
    "x-internal-token": internalToken,
    "x-request-id": reqId,
    "x-user-id": userId,
    "x-session-id": req.headers["x-session-id"] || "",
    ...(req.headers["x-device-id"]
      ? { "x-device-id": req.headers["x-device-id"] }
      : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };

  if (hasAuth) headers.Authorization = incomingAuth;

  return headers;
}

module.exports = {
  getUserId,
  safeUUID,
  auditForwardHeaders,

  /**
   * Exportés pour le test de garde. `IDEMPOTENCY_HEADERS` doit rester aligné
   * sur `extractIdempotencyKey` de TX Core : le test le vérifie.
   */
  IDEMPOTENCY_HEADERS,
  pickIdempotencyHeader,
};
