"use strict";

/**
 * ============================================================================
 * RELAIS DES RAPPELS PRESTATAIRES — PASSE-PLAT TRANSPARENT
 * ============================================================================
 *
 * Ce contrôleur ne comprend rien à ce qu'il transporte, et c'est sa qualité
 * principale. Il ne lit pas le corps, ne le désérialise pas, ne le valide pas :
 * il transmet des octets et des en-têtes à TX Core, qui détient les secrets et
 * décide seul si le rappel est authentique.
 *
 * ── Ce qu'il faisait avant, et pourquoi c'était cassé (audit du 2026-09-09) ──
 *
 * 1. **Il détruisait la signature.** Il transmettait `data: req.body`, un objet
 *    déjà désérialisé par `express.json()`, qu'axios re-sérialisait. Les octets
 *    signés par le prestataire étaient perdus : le HMAC recalculé par TX Core
 *    sur `req.rawBody` portait sur une chaîne différente. Corrigé par le
 *    parseur `express.raw()` monté en amont dans `src/app.js`.
 *
 * 2. **Il visait un chemin qui n'existe pas.** Il postait sur
 *    `${SERVICE}/webhooks/mobilemoney` et `${SERVICE}/webhooks/visa-direct`,
 *    alors que TX Core ne monte que `/webhooks/providers/:rail/:provider` et
 *    `/webhooks/providers/:provider` (`api-paynoval/src/server.js:1239`). Tout
 *    rappel passant par ici recevait donc un 404.
 *
 * 3. **Il devinait les en-têtes de signature.** Il en recopiait trois, choisis
 *    à la main (`stripe-signature`, `x-signature`, `x-paynoval-signature`). Or
 *    les adaptateurs de TX Core en attendent d'autres, propres à chaque
 *    opérateur : `x-wave-signature` / `x-wave-timestamp`,
 *    `x-visa-signature` / `x-visa-timestamp`… Aucun n'était transmis. Une
 *    liste d'en-têtes à recopier est une liste qu'on oublie de compléter : on
 *    relaie désormais TOUT, sauf ce qui est spécifique au saut réseau.
 *
 * ── Pourquoi le rail SEUL ne suffit pas ─────────────────────────────────────
 *
 * `/provider-webhooks/mobilemoney` ne dit pas QUEL opérateur a émis le rappel.
 * Or le secret de vérification est propre à chacun (`WAVE_WEBHOOK_SECRET`,
 * `ORANGE_WEBHOOK_SECRET`…). Deviner l'opérateur reviendrait à vérifier une
 * signature contre le mauvais secret : au mieux un refus incompréhensible, au
 * pire — si deux opérateurs partageaient un secret — une acceptation à tort.
 *
 * Le chemin canonique porte donc les deux : `/:rail/:provider`. Les deux
 * anciennes routes sans opérateur sont conservées et **échouent en fermeture**
 * (règle B.2), en nommant le chemin à utiliser. On ne les supprime pas : une
 * 410 explicite se diagnostique, un 404 se confond avec une panne de routage.
 *
 * ── Ce que ce module ne fait PAS, délibérément ──────────────────────────────
 *
 * Aucune vérification de signature ici. Le gateway ne détient pas les secrets
 * prestataires et ne doit pas les détenir : c'est le service qui règle l'argent
 * qui doit décider si le rappel est authentique. Poser un second point de
 * vérification créerait une seconde vérité sur « ce rappel est-il valable »,
 * donc une occasion de divergence. C'est la posture de Stripe et d'Adyen : le
 * point de terminaison du webhook est là où vit le secret.
 */

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

const logger = reqAny([
  "../src/logger",
  "../logger",
  "../src/utils/logger",
  "../utils/logger",
]);

const { safeAxiosRequest } = require("../src/services/transactions/httpClient");
const { baseTxCore } = require("../src/services/transactions/txCore");

/**
 * ⚠️ `normalizeRail` VENAIT DE `providerRegistry`, SUPPRIMÉ LE 2026-09-10.
 *
 * Il est repris ICI, à trois lignes, plutôt qu'importé d'un module de routage
 * que le bord n'a plus. La table `RAILS` juste en dessous est la source de
 * vérité de ce fichier ; ce normalisateur ne fait que ramener les alias connus
 * à ses deux clés.
 */
const OPERATEURS_MOBILEMONEY = Object.freeze(["wave", "orange", "mtn", "moov"]);

function normalizeRail(v) {
  const s = String(v || "").trim().toLowerCase();

  if (OPERATEURS_MOBILEMONEY.includes(s)) return "mobilemoney";
  if (["visa_direct", "visadirect", "card", "visa", "mastercard"].includes(s)) {
    return "card";
  }

  return s;
}

/**
 * Rails acceptés, et opérateurs de chacun. Table CLOSE : un rail ou un
 * opérateur inconnu est refusé, jamais transmis « au cas où ».
 *
 * ⚠️ Elle doit rester alignée sur `MOBILEMONEY_PROVIDERS` de
 * `providerRegistry.js` et sur les adaptateurs de TX Core
 * (`api-paynoval/src/providers/`). Périmètre arrêté le 2026-09-08 : trois
 * rails, et le rail interne PayNoval ne reçoit aucun rappel externe.
 */
const RAILS = Object.freeze({
  mobilemoney: Object.freeze(["wave", "orange", "mtn", "moov"]),
  card: Object.freeze(["visa_direct"]),
});

/**
 * En-têtes propres au SAUT RÉSEAU, qui ne doivent jamais être recopiés :
 * les retransmettre décrirait la connexion gateway → TX Core avec les valeurs
 * de la connexion prestataire → gateway. `content-length` en particulier
 * provoquerait une troncature ou un blocage si le corps différait d'un octet.
 */
const EN_TETES_DE_SAUT = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

/**
 * En-têtes que le gateway s'attribue et qu'un appelant ne doit jamais pouvoir
 * poser lui-même. Sans ce filtre, un tiers qui connaît le chemin public
 * pourrait présenter son propre `x-internal-token` et le voir relayé tel quel
 * à un service interne.
 */
const EN_TETES_RESERVES = new Set([
  "x-internal-token",
  "x-paynoval-internal-token",
  "x-forwarded-service",
  "authorization",
]);

function normaliserProvider(valeur) {
  return String(valeur || "").trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Recopie les en-têtes entrants, moins ceux du saut réseau et ceux que le
 * gateway se réserve, puis ajoute les siens.
 *
 * C'est l'inverse de l'ancienne approche : on part de TOUT et on retire ce
 * qu'on sait devoir retirer, au lieu de partir de rien et d'énumérer ce qu'on
 * croit devoir garder. Un en-tête de signature inventé demain par un nouvel
 * opérateur traversera sans qu'on ait à toucher ce fichier.
 */
function construireEnTetes(req, { rail, provider }) {
  const sortants = {};

  for (const [nom, valeur] of Object.entries(req.headers || {})) {
    const cle = String(nom).toLowerCase();

    if (EN_TETES_DE_SAUT.has(cle)) continue;
    if (EN_TETES_RESERVES.has(cle)) continue;
    if (valeur === undefined || valeur === null) continue;

    sortants[cle] = Array.isArray(valeur) ? valeur.join(", ") : String(valeur);
  }

  sortants["content-type"] =
    req.headers["content-type"] || "application/json";

  sortants["x-forwarded-service"] = "api-gateway";
  sortants["x-webhook-rail"] = rail;
  sortants["x-webhook-provider"] = provider;

  sortants["x-internal-token"] =
    process.env.GATEWAY_INTERNAL_TOKEN || process.env.INTERNAL_TOKEN || "";

  if (!sortants["x-request-id"]) {
    sortants["x-request-id"] = req.id || "";
  }

  return sortants;
}

/**
 * Le corps tel qu'il est arrivé. `express.raw()` en fait un `Buffer` ; on le
 * transmet sans le convertir, pour qu'aucun encodage intermédiaire ne s'y
 * glisse.
 *
 * ⚠️ LÈVE si le corps n'est pas un Buffer (règle B.2). Ce cas signifie que le
 * parseur `raw` n'a pas été appliqué — donc que l'ordre de montage de
 * `src/app.js` a bougé. Transmettre quand même produirait un rappel dont la
 * signature ne peut pas être vérifiée, et l'incident serait attribué au
 * prestataire plutôt qu'à nous.
 */
function corpsBrut(req) {
  if (Buffer.isBuffer(req.body)) return req.body;

  const e = new Error(
    "Corps de rappel non brut : `express.raw()` n'est pas monté sur " +
      "/api/v1/provider-webhooks, ou un parseur le précède. La signature du " +
      "prestataire ne peut pas survivre à une re-sérialisation — voir " +
      "l'ordre de montage dans src/app.js."
  );
  e.status = 500;
  throw e;
}

async function relayerVersTxCore(req, res, { rail, provider }) {
  /**
   * ⚠️ CE RELAIS CHERCHAIT L'URL DU RAIL, PAS CELLE DE TX CORE — corrigé le
   * 2026-09-10.
   *
   * Il faisait `getTargetService(rail === "card" ? "visa_direct" : rail)`,
   * c'est-à-dire qu'il demandait `SERVICE_VISA_DIRECT_URL` ou
   * `SERVICE_MOBILEMONEY_URL` — deux variables que la configuration laisse
   * vides, pour des microservices qui n'ont jamais été déployés.
   *
   * Résultat : **tout rappel prestataire mobile money ou carte repartait en
   * 503**, alors que la fonction s'appelle `relayerVersTxCore` et que son
   * commentaire cite le chemin exact servi par Tx-Core. Le défaut était
   * invisible faute de prestataire branché ; il se serait manifesté au PREMIER
   * rappel réel — c'est-à-dire au moment où l'argent arrive.
   */
  const serviceUrl = baseTxCore();

  if (!serviceUrl) {
    logger.error?.("[Gateway][Webhook] Tx-Core non configuré", { rail, provider });

    return res.status(503).json({
      success: false,
      error: "Moteur de transactions non configuré.",
      code: "WEBHOOK_SERVICE_UNCONFIGURED",
    });
  }

  /* Le chemin EXACT servi par TX Core : api-paynoval/src/server.js:1239. */
  const url = `${String(serviceUrl).replace(/\/+$/, "")}/webhooks/providers/${encodeURIComponent(
    rail
  )}/${encodeURIComponent(provider)}`;

  let brut;
  try {
    brut = corpsBrut(req);
  } catch (err) {
    logger.error?.("[Gateway][Webhook] corps non brut", {
      rail,
      provider,
      message: err?.message,
    });

    return res.status(500).json({
      success: false,
      error: "Relais de rappel mal configuré côté passerelle.",
      code: "WEBHOOK_RAW_BODY_MISSING",
    });
  }

  try {
    const reponse = await safeAxiosRequest({
      method: "post",
      url,
      data: brut,
      headers: construireEnTetes(req, { rail, provider }),
      timeout: 20000,

      /**
       * Sans cela axios inspecte `data` et peut le transformer. On veut un
       * transport d'octets, pas une sérialisation.
       */
      transformRequest: [(donnees) => donnees],
    });

    /**
     * Le code de statut de TX Core est retransmis TEL QUEL, et c'est essentiel :
     * il pilote le comportement de réémission du prestataire. Un 409
     * « traitement déjà en cours » doit rester un 409 — le convertir en 200
     * ferait cesser les réémissions sur un rappel qui peut encore échouer, et
     * l'événement serait perdu définitivement.
     */
    return res.status(reponse.status || 200).json(
      reponse.data || { success: true, forwarded: true, rail, provider }
    );
  } catch (err) {
    const statut = err?.response?.status;

    /**
     * ⚠️ On ne journalise NI le corps ni les en-têtes : le corps d'un rappel
     * porte le numéro et le nom du bénéficiaire, les en-têtes portent la
     * signature (règle B.4). Rail, opérateur et statut suffisent au diagnostic.
     */
    logger.error?.("[Gateway][Webhook] relais en échec", {
      rail,
      provider,
      status: statut || null,
      message: err?.message,
    });

    /**
     * Une panne du relais rend 502 et NON 200 : le prestataire doit réémettre.
     * Si TX Core a répondu, c'est SON statut qui fait foi — lui seul sait si le
     * rappel a été pris en compte.
     */
    return res.status(statut || 502).json({
      success: false,
      error:
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        "Relais du rappel impossible.",
      code: "WEBHOOK_FORWARD_FAILED",
      rail,
      provider,
    });
  }
}

/**
 * Route canonique : `POST /api/v1/provider-webhooks/:rail/:provider`.
 */
exports.relayWebhook = async (req, res) => {
  const rail = normalizeRail(req.params?.rail);
  const provider = normaliserProvider(req.params?.provider);

  const operateurs = RAILS[rail];

  if (!operateurs) {
    return res.status(404).json({
      success: false,
      error: `Rail de rappel inconnu : ${req.params?.rail}.`,
      code: "WEBHOOK_UNKNOWN_RAIL",
    });
  }

  if (!operateurs.includes(provider)) {
    /**
     * Table CLOSE. Un opérateur inconnu ne se transmet pas « au cas où » :
     * TX Core n'aurait pas d'adaptateur, donc pas de secret, donc pas de
     * vérification possible. Le refuser ici évite un aller-retour et dit
     * clairement ce qui manque.
     */
    return res.status(404).json({
      success: false,
      error: `Opérateur « ${req.params?.provider} » inconnu sur le rail ${rail}.`,
      code: "WEBHOOK_UNKNOWN_PROVIDER",
      accepted: operateurs,
    });
  }

  return relayerVersTxCore(req, res, { rail, provider });
};

/**
 * Anciennes routes sans opérateur — CONSERVÉES, FERMÉES.
 *
 * Elles ne peuvent pas fonctionner : sans opérateur, aucun secret ne peut être
 * choisi. Elles répondaient déjà 404 côté TX Core (chemin inexistant), donc
 * aucun trafic légitime n'en dépend. On les garde pour que le diagnostic soit
 * possible : une 410 nommant le chemin correct se comprend, un 404 se confond
 * avec une panne.
 */
function chemainSansOperateur(rail) {
  return async (req, res) => {
    logger.warn?.("[Gateway][Webhook] chemin hérité sans opérateur", {
      rail,
      path: req.originalUrl,
    });

    return res.status(410).json({
      success: false,
      error:
        `Ce chemin ne porte pas l'opérateur, or le secret de vérification lui ` +
        `est propre. Utiliser POST /api/v1/provider-webhooks/${rail}/<opérateur>.`,
      code: "WEBHOOK_PATH_REQUIRES_PROVIDER",
      accepted: RAILS[rail] || [],
    });
  };
}

exports.mobilemoneyWebhook = chemainSansOperateur("mobilemoney");
exports.visaDirectWebhook = chemainSansOperateur("card");

/* Exportés pour les tests de garde. */
exports.RAILS = RAILS;
exports.construireEnTetes = construireEnTetes;
exports.EN_TETES_DE_SAUT = EN_TETES_DE_SAUT;
exports.EN_TETES_RESERVES = EN_TETES_RESERVES;
