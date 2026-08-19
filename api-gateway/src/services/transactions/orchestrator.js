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

const mongoose = require("mongoose");

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
  normalizeCurrencyCode,
  extractTxArrayFromProviderPayload,
  injectTxArrayIntoProviderPayload,
} = require("./normalizers");
const {
  getTargetService,
  resolveProviderForRequest,
  normalizeProviderForRouting,
} = require("./providerRegistry");
const { getUserId, auditForwardHeaders } = require("./phoneSecurity");
const {
  listTxCache,
  listTxInflight,
  buildListTxCacheKey,
} = require("./listCache");
const {
  routeInitiateByFlow,
  routeActionByFlow,
  fetchCanonicalTransaction,
} = require("./transactionOrchestratorByFlow");
const { routeAdminActionByFlow } = require("./adminFlowRouter");

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

  const canonicalTx = await fetchCanonicalTransaction(req, id);
  if (!canonicalTx) {
    const e = new Error("Transaction introuvable");
    e.status = 404;
    throw e;
  }

  const normalized = normalizeTxForResponse(canonicalTx, userId);

  return {
    status: 200,
    body: {
      success: true,
      data: normalized,
    },
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
  const provider = normalizeProviderForRouting(
    resolveProviderForRequest(req, "paynoval")
  );
  const targetService = getTargetService(provider);

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
    provider,
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
        code: "no_provider_service",
        message:
          "Le service de paiement n'est pas configuré. Réessayez dans un instant.",
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
        provider,
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

async function initiateTransactionOrThrow(req) {
  return routeInitiateByFlow(req);
}

async function forwardSimpleActionOrThrow(req, action) {
  return routeActionByFlow(req, action);
}

async function forwardAdminActionOrThrow(req, action) {
  return routeAdminActionByFlow(req, action);
}

async function logInternalTransactionOrThrow(req) {
  if (mongoose.connection.readyState !== 1) {
    const e = new Error("MongoDB non connecté (log interne indisponible).");
    e.status = 503;
    throw e;
  }

  let Transaction = null;
  try {
    Transaction = reqAny([
      "../../src/models/Transaction",
      "../../models/Transaction",
    ]);
  } catch {
    const e = new Error("Model Transaction introuvable (log interne).");
    e.status = 500;
    throw e;
  }

  const now = new Date();
  const userId = getUserId(req) || req.body?.userId || null;

  if (!userId) {
    const e = new Error("userId manquant pour loguer la transaction.");
    e.status = 400;
    throw e;
  }

  const {
    provider = "paynoval",
    amount,
    status = "confirmed",
    currency,
    reference,
    meta = {},
  } = req.body || {};

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    const e = new Error("amount invalide ou manquant.");
    e.status = 400;
    throw e;
  }

  const countryHint =
    req.body?.country ||
    meta?.country ||
    meta?.recipientInfo?.country ||
    meta?.recipientInfo?.pays ||
    "";

  const legacyCurrency = normalizeCurrencyCode(currency, countryHint) || null;
  const outMeta =
    typeof meta === "object" && meta && !Array.isArray(meta) ? { ...meta } : {};

  const doc = await Transaction.create({
    userId,
    provider,
    amount: numAmount,
    status,
    currency: legacyCurrency || undefined,
    reference: reference || undefined,
    meta: outMeta,
    createdAt: now,
    updatedAt: now,
    confirmedAt: status === "confirmed" ? now : undefined,
  });

  const out = normalizeTxForResponse(
    doc.toObject ? doc.toObject() : doc,
    userId
  );

  return {
    status: 201,
    body: { success: true, data: out },
  };
}

module.exports = {
  getTransactionOrThrow,
  listTransactionsOrFallback,
  initiateTransactionOrThrow,
  forwardSimpleActionOrThrow,
  forwardAdminActionOrThrow,
  logInternalTransactionOrThrow,
};