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
      return {
        status: 200,
        body: {
          success: true,
          data: [],
          count: 0,
          total: 0,
          limit: Number(req.query?.limit || 25),
          skip: Number(req.query?.skip || 0),
          warning: "no_provider_service",
        },
      };
    }

    const url = `${cleanBaseUrl(targetService)}/transactions`;

    const cdBefore = getProviderCooldown(url);
    if (cdBefore) {
      return {
        status: 200,
        body: {
          success: true,
          data: [],
          count: 0,
          total: 0,
          limit: Number(req.query?.limit || 25),
          skip: Number(req.query?.skip || 0),
          warning: "provider_cooldown",
          retryAfterSec: cdBefore.retryAfterSec,
        },
      };
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
        return {
          status: 200,
          body: {
            success: true,
            data: [],
            count: 0,
            total: 0,
            limit: Number(req.query?.limit || 25),
            skip: Number(req.query?.skip || 0),
            warning: err.isCloudflareChallenge
              ? "provider_cloudflare_challenge"
              : "provider_cooldown",
            retryAfterSec: cd?.retryAfterSec,
          },
        };
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

      logger.error?.("[Gateway][TX] Erreur GET transactions (no DB fallback)", {
        status,
        error,
        provider,
      });

      return {
        status: 200,
        body: {
          success: true,
          data: [],
          count: 0,
          total: 0,
          limit: Number(req.query?.limit || 25),
          skip: Number(req.query?.skip || 0),
          warning: "provider_unavailable",
        },
      };
    }
  };

  const promise = (async () => {
    const out = await compute();
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