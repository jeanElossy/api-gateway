"use strict";

/**
 * --------------------------------------------------------------------------
 * Gateway Transactions Orchestrator
 * --------------------------------------------------------------------------
 * Rôle :
 * - lecture transaction canonique via PayNoval / TX Core
 * - fallback list proxy + cache
 * - routing initiate/action/admin
 * - log interne legacy si nécessaire
 *
 * IMPORTANT :
 * - GET transaction doit partir de la transaction canonique PayNoval
 * - confirm/cancel/admin sont ensuite routés flow-aware
 * --------------------------------------------------------------------------
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
  "../../src/logger",
  "../../logger",
  "../../src/utils/logger",
  "../../utils/logger",
]);

const { safeAxiosRequest, getProviderCooldown } = require("./httpClient");
const {
  normalizeTxForResponse,
  normalizeTxArray,
  extractTxArrayFromProviderPayload,
  injectTxArrayIntoProviderPayload,
} = require("./normalizers");
const { getUserId, auditForwardHeaders } = require("./phoneSecurity");
const {
  listTxCache,
  listTxInflight,
  buildListTxCacheKey,
} = require("./listCache");
const { baseTxCore, appelerTxCore } = require("./txCore");

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

/**
 * Lecture canonique :
 * on lit d’abord le TX Core / PayNoval.
 */
async function getTransactionOrThrow(req) {
  const userId = getUserId(req);
  const { id } = req.params;

  const { body } = await appelerTxCore({
    req,
    method: "get",
    chemin: `/transactions/${encodeURIComponent(String(id))}`,
    timeout: 12000,
  });

  const brut = body?.data || body?.transaction || body;

  if (!brut || typeof brut !== "object" || Array.isArray(brut)) {
    const e = new Error("Transaction introuvable");
    e.status = 404;
    throw e;
  }

  return {
    status: 200,
    body: { success: true, data: normalizeTxForResponse(brut, userId) },
  };
}

/**
 * Liste :
 * garde encore un provider par requête, mais avec cache/fallback défensif.
 * Pour ton usage actuel ça reste acceptable.
 */
/**
 * ÉCHEC DE CHARGEMENT — ET NON « AUCUNE TRANSACTION ».
 *
 * ═══ CE QUE CE CODE FAISAIT, ET POURQUOI C'ÉTAIT GRAVE ══════════════════════
 *
 * Quatre chemins d'erreur — service absent, refroidissement fournisseur, défi
 * Cloudflare, erreur HTTP — répondaient tous `200 { success: true, data: [] }`.
 * Autrement dit : « la requête a réussi, vous n'avez aucune transaction ».
 *
 * L'application mobile est pourtant écrite correctement : sur erreur, elle
 * affiche un message ET restaure son cache local. Le faux succès la privait de
 * ce filet, puis — bien pire — écrasait ce cache avec la liste vide
 * (`AsyncStorage.setItem('transactions_<id>', '[]')`). Une seule limite de débit
 * atteinte suffisait donc à faire *disparaître* l'historique, y compris hors
 * ligne. C'est exactement ce qui a été observé le 2026-08-19.
 *
 * ═══ CE QUE FONT STRIPE, PAYPAL ET WISE ═════════════════════════════════════
 *
 * Aucun ne déguise une panne en succès. Un dépassement de quota est un **429**
 * accompagné de `Retry-After` ; un service en difficulté est un **503**. Le
 * client sait alors distinguer « rien à afficher » de « je n'ai pas pu
 * regarder » — distinction sans laquelle aucune reprise n'est possible, ni par
 * la machine, ni par l'utilisateur.
 */
function listFailure({ status, code, message, retryAfterSec = null }) {
  const headers = {};

  // `Retry-After` est ce qui rend l'erreur exploitable sans deviner : le client
  // sait quand réessayer au lieu de marteler le service déjà en peine.
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterSec));
  }

  return {
    status,
    headers,
    body: {
      success: false,
      code,
      error: message,
      message,
      ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? { retryAfterSec: Math.ceil(retryAfterSec) }
        : {}),
    },
  };
}

async function listTransactionsOrFallback(req) {
  /**
   * ⚠️ PLUS DE RÉSOLUTION DE PRESTATAIRE ICI — 2026-09-10.
   *
   * Ce handler choisissait un prestataire (`resolveProviderForRequest`) puis
   * son microservice (`getTargetService`). Les deux seules issues possibles
   * étaient Tx-Core (pour `paynoval`) ou une chaîne vide — les autres URL de
   * service ne sont pas déployées. La liste des transactions d'un utilisateur
   * n'a d'ailleurs jamais dépendu d'un rail : elle est la même quel que soit
   * le moyen de paiement.
   */
  const targetService = baseTxCore();

  const userId = getUserId(req);
  if (!userId) {
    return {
      status: 401,
      body: { success: false, error: "Non autorisé." },
    };
  }

  try {
    req.res?.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    req.res?.set("Pragma", "no-cache");
    req.res?.set("Expires", "0");
  } catch {}

  const cacheKey = buildListTxCacheKey({
    userId,
    provider: "txcore",
    query: req.query,
  });

  const cached = listTxCache.get(cacheKey);
  if (cached && cached.body) return cached;

  const inflight = listTxInflight.get(cacheKey);
  if (inflight && typeof inflight.then === "function") {
    try {
      return await inflight;
    } catch {
      listTxInflight.delete(cacheKey);
    }
  }

  const compute = async () => {
    if (!targetService) {
      return listFailure({
        status: 503,
        code: "tx_core_unconfigured",
        message:
          "Le moteur de transactions n'est pas configuré. Réessayez dans un instant.",
      });
    }

    const url = `${cleanBaseUrl(targetService)}/transactions`;

    const cdBefore = getProviderCooldown(url);
    if (cdBefore) {
      return listFailure({
        status: 503,
        code: "provider_cooldown",
        message:
          "Le service de paiement est momentanément indisponible. Réessayez dans un instant.",
        retryAfterSec: cdBefore.retryAfterSec,
      });
    }

    try {
      const response = await safeAxiosRequest({
        method: "get",
        url,
        headers: auditForwardHeaders(req),
        params: req.query,
        timeout: 15000,
      });

      const payload = response.data || {};
      const providerListRaw = extractTxArrayFromProviderPayload(payload);
      const providerList = normalizeTxArray(providerListRaw, userId);

      const finalPayload = injectTxArrayIntoProviderPayload(payload, providerList);

      finalPayload.success = finalPayload.success ?? true;
      finalPayload.count = providerList.length;
      finalPayload.total = providerList.length;
      finalPayload.limit = Number(req.query?.limit || finalPayload.limit || 25);
      finalPayload.skip = Number(req.query?.skip || finalPayload.skip || 0);
      finalPayload.items = providerList.length;

      return { status: 200, body: finalPayload };
    } catch (err) {
      if (err.isProviderCooldown || err.isCloudflareChallenge) {
        const cd = err.cooldown || getProviderCooldown(url);

        return listFailure({
          status: 503,
          code: err.isCloudflareChallenge
            ? "provider_cloudflare_challenge"
            : "provider_cooldown",
          message:
            "Le service de paiement est momentanément indisponible. Réessayez dans un instant.",
          retryAfterSec: cd?.retryAfterSec,
        });
      }

      const status = err.response?.status || err.status || 502;
      let error =
        err.response?.data?.error ||
        err.response?.data?.message ||
        (typeof err.response?.data === "string" ? err.response.data : null) ||
        "Erreur lors du proxy GET transactions";

      if (status === 429) {
        error =
          "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants.";
      }

      logger.error?.("[Gateway][TX] Erreur GET transactions", {
        status,
        error,
      });

      /**
       * Le 429 du fournisseur est relayé TEL QUEL, avec son `Retry-After`.
       * Le traduire en 503 effacerait l'information la plus utile : ce n'est
       * pas le service qui est en panne, c'est nous qui avons trop demandé.
       */
      if (status === 429) {
        const retryAfterSec =
          Number(err.response?.headers?.["retry-after"]) || 30;

        return listFailure({
          status: 429,
          code: "rate_limited",
          message: error,
          retryAfterSec,
        });
      }

      /**
       * Une erreur 4xx du fournisseur est relayée : elle décrit la requête.
       * Tout le reste devient 503 — c'est un incident de service, pas une
       * faute du client, et c'est ce que le client doit pouvoir réessayer.
       */
      return listFailure({
        status: status >= 400 && status < 500 ? status : 503,
        code: "provider_unavailable",
        message: error,
      });
    }
  };

  const promise = (async () => {
    const out = await compute();

    /**
     * ⚠️ UN ÉCHEC NE SE MET PAS EN CACHE.
     *
     * Le cache retenait indistinctement succès et erreurs. Une seule limite de
     * débit atteinte servait donc la même erreur à toutes les requêtes
     * suivantes pendant la durée de vie de l'entrée — y compris après le
     * rétablissement du fournisseur. On prolongeait la panne au lieu de la
     * laisser se résorber.
     */
    if (!out || Number(out.status) >= 400) return out;

    listTxCache.set(cacheKey, out);
    return out;
  })();

  listTxInflight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    listTxInflight.delete(cacheKey);
  }
}

/**
 * ============================================================================
 * INITIER, CONFIRMER, ANNULER, ADMINISTRER — TOUT VA AU MOTEUR
 * ============================================================================
 *
 * Ces quatre fonctions passaient par `routeInitiateByFlow`, `routeActionByFlow`
 * et `routeAdminActionByFlow` : 1 051 lignes qui résolvaient un flux, en
 * déduisaient un prestataire, cherchaient son microservice, puis appelaient l'un
 * des trois adaptateurs.
 *
 * Deux des trois adaptateurs visaient des URL vides — les rails mobile money et
 * carte étaient donc FERMÉS au bord, en 400, avant d'atteindre le moteur. Le
 * troisième pointait sur Tx-Core.
 *
 * Tx-Core, lui, résout le flux (`flowHelpers.resolveExternalFlow`), choisit le
 * prestataire (`resolveProviderForFlow`) et possède les cinq adaptateurs réels.
 * Le bord dupliquait une décision qu'il n'avait pas les moyens d'exécuter.
 *
 * ⚠️ LE CORPS PART TEL QUE `normalizers` L'A TRADUIT, et le statut revient
 * VERBATIM. Réécrire un statut ici ferait perdre la distinction entre « ta
 * demande est invalide » (4xx) et « je n'ai pas pu » (5xx) — la seule qui
 * permette au client de savoir s'il doit corriger ou réessayer.
 */

async function initiateTransactionOrThrow(req) {
  const userId = getUserId(req);

  const { status, body } = await appelerTxCore({
    req,
    method: "post",
    chemin: "/transactions/initiate",
    body: req.body,
    timeout: 20000,
  });

  return { status, body: traduireReponse(body, userId) };
}

async function forwardSimpleActionOrThrow(req, action) {
  const userId = getUserId(req);

  const { status, body } = await appelerTxCore({
    req,
    method: "post",
    chemin: `/transactions/${encodeURIComponent(String(action))}`,
    body: req.body,
    timeout: 20000,
  });

  return { status, body: traduireReponse(body, userId) };
}

/**
 * Les actions d'administration empruntent le MÊME chemin.
 *
 * `adminFlowRouter.js` en faisait un cas à part : il relisait la transaction
 * canonique pour en déduire le flux, puis routait. Tx-Core applique déjà
 * `requireRole` sur ces chemins et connaît le flux de la transaction — il n'a
 * jamais eu besoin qu'on le lui dise.
 */
async function forwardAdminActionOrThrow(req, action) {
  return forwardSimpleActionOrThrow(req, action);
}

/**
 * Traduit la réponse du moteur vers la forme attendue par le client. C'est la
 * couche anti-corruption en SORTIE : Stripe fait la même chose pour ses
 * anciennes versions d'API.
 *
 * ⚠️ TROIS FORMES, ET LA TROISIÈME EST CELLE D'`/initiate`.
 *
 * Tx-Core enveloppe tantôt dans `data`, tantôt dans `transaction`, et rend
 * parfois un corps PLAT — `/transactions/initiate` répond
 * `{ success, transactionId, reference, flow, status, pricing, … }` sans
 * aucune clé d'enveloppe (`initiateInternal.js:962`).
 *
 * L'adaptateur remplacé traitait ce cas : il normalisait alors le corps ENTIER.
 * Ne pas le reproduire aurait privé la réponse d'initiation des champs dérivés
 * (`money`, `id`, devises normalisées) que l'application mobile lit — une
 * régression de contrat invisible aux tests, qui ne serait apparue qu'au
 * premier virement.
 *
 * `normalizeTxForResponse` ENRICHIT sans retirer (`const out = { ...tx }`) :
 * appliquer la normalisation à un corps plat lui ajoute les champs dérivés
 * sans toucher aux siens.
 */
function traduireReponse(payload, userId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    return { ...payload, data: normalizeTxForResponse(payload.data, userId) };
  }

  if (
    payload.transaction &&
    typeof payload.transaction === "object" &&
    !Array.isArray(payload.transaction)
  ) {
    return {
      ...payload,
      transaction: normalizeTxForResponse(payload.transaction, userId),
    };
  }

  /* Corps plat — le cas d'`/initiate`. */
  return normalizeTxForResponse(payload, userId);
}

module.exports = {
  getTransactionOrThrow,
  listTransactionsOrFallback,
  initiateTransactionOrThrow,
  forwardSimpleActionOrThrow,
  forwardAdminActionOrThrow,
};
