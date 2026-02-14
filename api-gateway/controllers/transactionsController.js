"use strict";

/**
 * -------------------------------------------------------------------
 * CONTROLLER TRANSACTIONS (API GATEWAY) — ORCHESTRATEUR PRO
 * -------------------------------------------------------------------
 * ✅ Gateway = proxy + routing + sécurité edge + anti-429/CF + normalisation UI
 * ✅ Source of truth = microservices (TX Core + providers)
 * ✅ Pas de DB "Transaction" officielle dans la gateway (sauf log interne optionnel)
 *
 * ✅ Nouveau flow "MobileMoney providers"
 * - funds/destination doivent être "mobilemoney"
 * - metadata.provider = "wave" | "orange" | "mtn" | "moov" | "flutterwave" ...
 *
 * ✅ Nouveau flow sécurité (TX Core)
 * - initiate: forward securityQuestion + securityAnswer (TX Core hash)
 * - confirm: forward securityAnswer (TX Core valide avant crédit)
 * - la gateway ne hash pas (source of truth = TX Core)
 */

const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { LRUCache } = require("lru-cache");

/* ------------------------ Safe require (paths robustes) ------------------------ */
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

const config = reqAny(["../src/config", "../config"]);
const logger = reqAny(["../src/logger", "../logger"]);

const { normalizeCurrency } = reqAny(["../src/utils/currency", "../utils/currency"]);

// OTP trusted numbers model (DB). On gère Mongo KO proprement.
let TrustedDepositNumber = null;
try {
  TrustedDepositNumber = reqAny(["../src/models/TrustedDepositNumber", "../models/TrustedDepositNumber"]);
} catch {
  TrustedDepositNumber = null;
}

/* -------------------------------------------------------------------
 *                  ✅ Cloudflare / 429 Circuit Breaker
 * ------------------------------------------------------------------- */
const FAIL_COOLDOWN_MS = Number(process.env.PROVIDER_FAIL_COOLDOWN_MS || 5 * 60 * 1000); // 5min
const FAIL_CACHE_MAX = Number(process.env.PROVIDER_FAIL_CACHE_MAX || 200);
const providerFail = new LRUCache({ max: FAIL_CACHE_MAX, ttl: FAIL_COOLDOWN_MS });

function getServiceKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return String(url || "").slice(0, 60);
  }
}

function setProviderCooldown(url, reason, extra = {}) {
  const key = getServiceKeyFromUrl(url);
  const now = Date.now();

  const retryAfterSec = Number(extra.retryAfterSec);
  const cdMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : FAIL_COOLDOWN_MS;

  const payload = {
    key,
    reason: reason || "provider_unavailable",
    nextTryAt: now + cdMs,
    retryAfterSec: Math.ceil(cdMs / 1000),
    ...extra,
  };

  providerFail.set(key, payload);
  return payload;
}

function getProviderCooldown(url) {
  const key = getServiceKeyFromUrl(url);
  const v = providerFail.get(key);
  if (!v) return null;
  if (Date.now() < v.nextTryAt) return v;
  providerFail.delete(key);
  return null;
}

function isCloudflareChallengeResponse(response) {
  if (!response) return false;
  const status = response.status;
  const data = response.data;

  if (!data || typeof data !== "string") return false;
  const lower = data.toLowerCase();

  const looksLikeHtml = lower.includes("<html") || lower.includes("<!doctype html");

  const hasCloudflareMarkers =
    lower.includes("just a moment") ||
    lower.includes("attention required") ||
    lower.includes("cdn-cgi/challenge-platform") ||
    lower.includes("__cf_chl_") ||
    lower.includes("cloudflare");

  const suspiciousStatus = status === 403 || status === 429 || status === 503;

  return hasCloudflareMarkers && (suspiciousStatus || looksLikeHtml);
}

/**
 * ✅ safeAxiosRequest
 * - détecte CF/429
 * - met en cooldown par origin
 */
async function safeAxiosRequest(opts) {
  const finalOpts = { ...opts };
  if (!finalOpts.timeout) finalOpts.timeout = 15000;
  finalOpts.method = finalOpts.method || "get";

  finalOpts.headers = { ...(finalOpts.headers || {}) };
  const hasUA = finalOpts.headers["User-Agent"] || finalOpts.headers["user-agent"];
  if (!hasUA) finalOpts.headers["User-Agent"] = GATEWAY_USER_AGENT;

  const cd = getProviderCooldown(finalOpts.url);
  if (cd) {
    const e = new Error(`Provider cooldown (${cd.retryAfterSec}s)`);
    e.isProviderCooldown = true;
    e.cooldown = cd;
    e.response = { status: 503, data: { error: "provider_cooldown", cooldown: cd } };
    throw e;
  }

  try {
    const response = await axios(finalOpts);

    if (isCloudflareChallengeResponse(response)) {
      const cd2 = setProviderCooldown(finalOpts.url, "cloudflare_challenge", { retryAfterSec: 60 });
      const e = new Error("Cloudflare challenge détecté");
      e.response = response;
      e.isCloudflareChallenge = true;
      e.cooldown = cd2;
      throw e;
    }

    const key = getServiceKeyFromUrl(finalOpts.url);
    providerFail.delete(key);

    return response;
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || null;
    const message = err.message || "Erreur axios inconnue";

    const preview = typeof data === "string" ? data.slice(0, 300) : data;
    const isCf = err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
    const isRateLimited = status === 429;

    if (isRateLimited || isCf) {
      const ra = Number(err.response?.headers?.["retry-after"]);
      const cd3 = setProviderCooldown(finalOpts.url, isCf ? "cloudflare_challenge" : "rate_limited", {
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
        status,
      });

      logger.warn?.("[Gateway][Axios] cooldown set", {
        url: finalOpts.url,
        status,
        reason: cd3.reason,
        retryAfterSec: cd3.retryAfterSec,
      });

      err.cooldown = cd3;
    }

    logger.error?.("[Gateway][Axios] request failed", {
      url: finalOpts.url,
      method: finalOpts.method,
      status,
      isCloudflare: isCf,
      isRateLimited,
      dataPreview: preview,
      message,
    });

    const e = new Error(message);
    e.response = err.response;
    e.isCloudflareChallenge = isCf;
    e.isRateLimited = isRateLimited;
    e.cooldown = err.cooldown;
    throw e;
  }
}

/* -------------------------------------------------------------------
 *                    ✅ Multi-currency helpers (ISO stable + viewer)
 * ------------------------------------------------------------------- */

// number safe
function nNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function normalizeCurrencyCode(v, countryHint = "") {
  const out = normalizeCurrency ? normalizeCurrency(v, countryHint) : "";
  return out ? String(out).toUpperCase() : null;
}

function toIdStr(v) {
  if (!v) return "";
  try {
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.toString) return v.toString();
  } catch {}
  return String(v);
}

function sameId(a, b) {
  const as = toIdStr(a);
  const bs = toIdStr(b);
  return !!as && !!bs && as === bs;
}

// Calcule direction relative au viewer (pour amountViewer)
function computeDirectionForViewer(tx, viewerUserId) {
  const me = viewerUserId ? String(viewerUserId) : "";

  const owner =
    tx?.ownerUserId ||
    tx?.initiatorUserId ||
    tx?.createdBy ||
    tx?.userId ||
    tx?.meta?.ownerUserId ||
    tx?.meta?.initiatorUserId ||
    tx?.meta?.createdBy;

  const receiver =
    tx?.receiver ||
    tx?.receiverUserId ||
    tx?.toUserId ||
    tx?.meta?.receiver ||
    tx?.meta?.receiverUserId;

  if (me && receiver && sameId(receiver, me)) return "credit";
  if (me && owner && sameId(owner, me)) return "debit";
  if (me && tx?.userId && sameId(tx.userId, me)) return "debit";

  return "";
}

/**
 * Construit un "money" robuste depuis tx + meta.
 */
function buildMoneyView(tx = {}, viewerUserId = null) {
  const m = tx.meta || {};
  const r = m?.recipientInfo || {};

  const countryHint = tx.country || m.country || r.country || "";

  const sourceCurrency =
    normalizeCurrencyCode(tx.currencySource, countryHint) ||
    normalizeCurrencyCode(m.currencySource, countryHint) ||
    normalizeCurrencyCode(m.selectedCurrency, countryHint) ||
    normalizeCurrencyCode(m.payerCurrencyCode, countryHint) ||
    normalizeCurrencyCode(m.baseCurrencyCode, countryHint) ||
    normalizeCurrencyCode(r.selectedCurrency, countryHint) ||
    normalizeCurrencyCode(r.currencySender, countryHint) ||
    normalizeCurrencyCode(r.senderCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(m.senderCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(tx.currency, countryHint);

  const targetCurrency =
    normalizeCurrencyCode(tx.currencyTarget, countryHint) ||
    normalizeCurrencyCode(m.currencyTarget, countryHint) ||
    normalizeCurrencyCode(m.localCurrencyCode, countryHint) ||
    normalizeCurrencyCode(r.localCurrencyCode, countryHint) ||
    normalizeCurrencyCode(m.localCurrencySymbol, countryHint) ||
    normalizeCurrencyCode(r.localCurrencySymbol, countryHint) ||
    null;

  const amountSource =
    nNum(tx.amountSource) ??
    nNum(m.amountSource) ??
    nNum(m.amountPayer) ??
    nNum(r.amountPayer) ??
    nNum(m.amount) ??
    nNum(r.amount) ??
    nNum(tx.amount);

  const amountTarget =
    nNum(tx.amountTarget) ??
    nNum(m.amountTarget) ??
    nNum(m.localAmount) ??
    nNum(r.localAmount) ??
    nNum(m.amountCreator) ??
    nNum(r.amountCreator) ??
    nNum(tx.netAmount) ??
    null;

  const feeSource =
    nNum(tx.feeSource) ??
    nNum(m.feeSource) ??
    nNum(m.transactionFees) ??
    nNum(r.transactionFees) ??
    nNum(m.feeAmount) ??
    nNum(tx.fees) ??
    null;

  const fx =
    nNum(tx.fxRateSourceToTarget) ??
    nNum(m.fxRateSourceToTarget) ??
    nNum(m.exchangeRate) ??
    nNum(r.exchangeRate) ??
    nNum(m.fxPayerToCreator) ??
    nNum(m?.fxBaseToAdmin?.rate) ??
    null;

  const money = {
    source: amountSource != null && sourceCurrency ? { amount: amountSource, currency: sourceCurrency } : null,
    feeSource: feeSource != null && sourceCurrency ? { amount: feeSource, currency: sourceCurrency } : null,
    target: amountTarget != null && targetCurrency ? { amount: amountTarget, currency: targetCurrency } : null,
    fxRateSourceToTarget: fx != null ? fx : null,
  };

  const direction = computeDirectionForViewer(tx, viewerUserId);
  const viewerAtom = direction === "credit" ? money.target : direction === "debit" ? money.source : null;

  const viewerCurrencyCode = viewerAtom?.currency || money.source?.currency || money.target?.currency || null;
  const amountViewer = viewerAtom?.amount ?? null;

  return { money, viewerCurrencyCode, amountViewer, direction, countryHint };
}

function normalizeTxForResponse(tx, viewerUserId = null) {
  if (!tx || typeof tx !== "object") return tx;

  const out = { ...tx };
  out.id = out.id || (out._id ? String(out._id) : undefined);

  const { money, viewerCurrencyCode, amountViewer, direction, countryHint } = buildMoneyView(out, viewerUserId);

  const isoLegacy = normalizeCurrencyCode(out.currency, countryHint);
  if (isoLegacy) out.currency = isoLegacy;

  out.currencySource = normalizeCurrencyCode(out.currencySource, countryHint) || money.source?.currency || null;
  out.amountSource = out.amountSource != null ? out.amountSource : money.source?.amount ?? null;
  out.feeSource = out.feeSource != null ? out.feeSource : money.feeSource?.amount ?? null;

  out.currencyTarget = normalizeCurrencyCode(out.currencyTarget, countryHint) || money.target?.currency || null;
  out.amountTarget = out.amountTarget != null ? out.amountTarget : money.target?.amount ?? null;

  out.fxRateSourceToTarget =
    out.fxRateSourceToTarget != null ? out.fxRateSourceToTarget : money.fxRateSourceToTarget ?? null;

  out.money = {
    source: money.source,
    feeSource: money.feeSource,
    target: money.target,
    fxRateSourceToTarget: money.fxRateSourceToTarget,
  };

  out.viewerCurrencyCode = viewerCurrencyCode;
  out.amountViewer = amountViewer;
  out.directionForViewer = direction;

  out.meta = { ...(out.meta || {}) };
  if (viewerCurrencyCode) out.meta.viewerCurrencyCode = viewerCurrencyCode;
  if (amountViewer != null) out.meta.amountViewer = amountViewer;

  if (out.currencySource && (!out.currency || out.currency.length !== 3)) out.currency = out.currencySource;

  // ✅ petite hygiene : pas d'exposition de secrets (si provider renvoie trop)
  if (out.securityAnswerHash) delete out.securityAnswerHash;
  if (out.securityCode) delete out.securityCode;
  if (out.verificationToken) delete out.verificationToken;

  return out;
}

function normalizeTxArray(list = [], viewerUserId = null) {
  return (Array.isArray(list) ? list : []).map((t) => normalizeTxForResponse(t, viewerUserId));
}

/* -------------------------------------------------------------------
 *                        Helpers phone OTP
 * ------------------------------------------------------------------- */
const COUNTRY_DIAL = {
  CI: { dial: "+225", localMin: 8, localMax: 10 },
  BF: { dial: "+226", localMin: 8, localMax: 8 },
  ML: { dial: "+223", localMin: 8, localMax: 8 },
  CM: { dial: "+237", localMin: 8, localMax: 9 },
  SN: { dial: "+221", localMin: 9, localMax: 9 },
  BJ: { dial: "+229", localMin: 8, localMax: 8 },
  TG: { dial: "+228", localMin: 8, localMax: 8 },
};

function digitsOnly(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizePhoneE164(rawPhone, country) {
  const raw = String(rawPhone || "").trim().replace(/\s+/g, "");
  if (!raw) return "";

  if (raw.startsWith("+")) {
    const d = "+" + digitsOnly(raw);
    if (d.length < 8 || d.length > 16) return "";
    return d;
  }

  const c = String(country || "").toUpperCase().trim();
  const cfg = COUNTRY_DIAL[c];
  if (!cfg) return "";

  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.length < cfg.localMin || d.length > cfg.localMax) return "";
  return cfg.dial + d;
}

function pickUserPrimaryPhoneE164(user, countryFallback) {
  if (!user) return "";

  const direct = user.phoneE164 || user.phoneNumber || user.phone || user.mobile || "";
  const ctry = user.country || countryFallback || "";
  let e164 = normalizePhoneE164(direct, ctry);
  if (e164) return e164;

  if (Array.isArray(user.mobiles)) {
    const mm = user.mobiles.find((m) => m && (m.e164 || m.numero));
    if (mm) {
      e164 = normalizePhoneE164(mm.e164 || mm.numero, mm.country || ctry);
      if (e164) return e164;
    }
  }
  return "";
}

function getBaseUrlFromReq(req) {
  const envBase = process.env.GATEWAY_URL || process.env.APP_BASE_URL || process.env.GATEWAY_BASE_URL || "";
  if (envBase) return String(envBase).replace(/\/+$/, "");

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

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

function auditForwardHeaders(req) {
  const incomingAuth = req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== "bearer null" &&
    String(incomingAuth).trim().toLowerCase() !== "null";

  const reqId = req.headers["x-request-id"] || req.id || safeUUID();
  const userId = getUserId(req) || req.headers["x-user-id"] || "";

  const internalToken = process.env.GATEWAY_INTERNAL_TOKEN || process.env.INTERNAL_TOKEN || config.internalToken || "";

  const headers = {
    Accept: "application/json",
    "x-internal-token": internalToken,
    "x-request-id": reqId,
    "x-user-id": userId,
    "x-session-id": req.headers["x-session-id"] || "",
    ...(req.headers["x-device-id"] ? { "x-device-id": req.headers["x-device-id"] } : {}),
  };

  if (hasAuth) headers.Authorization = incomingAuth;

  return headers;
}

/* ---------------- OTP status helper ---------------- */
async function fetchOtpStatus({ req, phoneE164, country }) {
  const base = getBaseUrlFromReq(req);
  if (!base) return { ok: false, trusted: false, status: "unknown" };

  const url = `${base}/api/v1/phone-verification/status`;

  try {
    const r = await safeAxiosRequest({
      method: "get",
      url,
      params: { phoneNumber: phoneE164, country },
      headers: auditForwardHeaders(req),
      timeout: 8000,
    });

    const payload = r?.data || {};
    const data = payload?.data || payload;

    const status = String(data?.status || "none").toLowerCase();
    const trusted = !!data?.trusted || status === "trusted";

    return { ok: true, trusted, status, data };
  } catch (e) {
    logger?.warn?.("[Gateway][OTP] status call failed", { message: e?.message });
    return { ok: false, trusted: false, status: "unknown" };
  }
}

/* -------------------------------------------------------------------
 *                          Provider mapping
 * ------------------------------------------------------------------- */
const PROVIDER_TO_SERVICE = {
  paynoval: process.env.PAYNOVAL_SERVICE_URL || config.microservices?.paynoval,
  stripe: config.microservices?.stripe,
  bank: config.microservices?.bank,
  mobilemoney: config.microservices?.mobilemoney,
  visa_direct: config.microservices?.visa_direct,
  visadirect: config.microservices?.visa_direct,
  cashin: config.microservices?.cashin,
  cashout: config.microservices?.cashout,
  stripe2momo: config.microservices?.stripe2momo,
  flutterwave: config.microservices?.flutterwave,
};

const GATEWAY_USER_AGENT = config.gatewayUserAgent || "PayNoval-Gateway/1.0 (+https://paynoval.com)";

/**
 * computeProviderSelected(action,funds,destination)
 */
function computeProviderSelected(action, funds, destination) {
  const a = String(action || "").toLowerCase().trim();
  const f = String(funds || "").toLowerCase().trim();
  const d = String(destination || "").toLowerCase().trim();

  if (a === "deposit") return f;
  if (a === "withdraw") return d;
  return d;
}

function resolveProvider(req, fallback = "paynoval") {
  const body = req.body || {};
  const query = req.query || {};

  // prior set by middleware
  const routed = req.routedProvider || req.providerSelected;
  if (routed) return String(routed).toLowerCase();

  // direct keys
  if (body.providerSelected) return String(body.providerSelected).toLowerCase();
  if (body.provider) return String(body.provider).toLowerCase();

  // legacy keys
  if (body.destination) return String(body.destination).toLowerCase();
  if (query.provider) return String(query.provider).toLowerCase();

  return String(fallback).toLowerCase();
}

/* -------------------------------------------------------------------
 *                  ✅ Nouveau flow: mobilemoney providers
 * ------------------------------------------------------------------- */
const MOBILEMONEY_PROVIDERS = new Set(["wave", "orange", "mtn", "moov", "flutterwave"]);

function ensureMetaProvider(req) {
  const b = req.body || {};
  b.metadata = typeof b.metadata === "object" && b.metadata ? b.metadata : {};
  req.body = b;
  return b;
}

function normalizeMobileMoneyProviderInBody(req) {
  const b = ensureMetaProvider(req);

  // provider candidat (peut venir de plusieurs champs)
  const p =
    String(
      b.metadata?.provider ||
        b.provider ||
        b.providerSelected ||
        b.mmProvider ||
        b.operator ||
        ""
    )
      .trim()
      .toLowerCase() || "";

  const funds = String(b.funds || "").trim().toLowerCase();
  const dest = String(b.destination || "").trim().toLowerCase();

  // Cas où funds/destination sont directement "wave/orange/..." (legacy)
  const pFromFunds = MOBILEMONEY_PROVIDERS.has(funds) ? funds : "";
  const pFromDest = MOBILEMONEY_PROVIDERS.has(dest) ? dest : "";

  const finalProvider = p || pFromFunds || pFromDest;

  if (finalProvider && MOBILEMONEY_PROVIDERS.has(finalProvider)) {
    b.metadata.provider = finalProvider;

    // ✅ normalise funds/destination en "mobilemoney" si c'était un provider
    if (MOBILEMONEY_PROVIDERS.has(funds)) b.funds = "mobilemoney";
    if (MOBILEMONEY_PROVIDERS.has(dest)) b.destination = "mobilemoney";
  }

  // petite hygiene: ne pas laisser providerSelected être "wave" etc.
  // (mais on ne supprime pas pour compat; on le laisse si le client l'envoie)
  req.body = b;
  return b;
}

/* -------------------------------------------------------------------
 *                    LIST cache anti-spam (8s)
 * ------------------------------------------------------------------- */
const LIST_TX_CACHE_TTL_MS = (() => {
  const n = Number(process.env.LIST_TX_CACHE_TTL_MS || 8000);
  return Number.isFinite(n) && n >= 1000 ? n : 8000;
})();
const LIST_TX_CACHE_MAX = (() => {
  const n = Number(process.env.LIST_TX_CACHE_MAX || 500);
  return Number.isFinite(n) && n >= 50 ? n : 500;
})();
const listTxCache = new LRUCache({ max: LIST_TX_CACHE_MAX, ttl: LIST_TX_CACHE_TTL_MS });
const listTxInflight = new LRUCache({ max: LIST_TX_CACHE_MAX, ttl: LIST_TX_CACHE_TTL_MS });

function _stableQueryString(obj = {}) {
  try {
    const keys = Object.keys(obj || {}).sort();
    const parts = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const it of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(it))}`);
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.join("&");
  } catch {
    return "";
  }
}

function _listTxCacheKey({ userId, provider, query }) {
  const qs = _stableQueryString(query || {});
  return `u:${String(userId)}|p:${String(provider)}|q:${qs}`;
}

function extractTxArrayFromProviderPayload(payload) {
  const candidates = [
    payload?.data,
    payload?.transactions,
    payload?.data?.transactions,
    payload?.data?.data,
    payload?.result,
    payload?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function injectTxArrayIntoProviderPayload(payload, list) {
  if (!payload || typeof payload !== "object") return { success: true, data: list };

  if (Array.isArray(payload.data)) {
    payload.data = list;
    return payload;
  }
  if (Array.isArray(payload.transactions)) {
    payload.transactions = list;
    return payload;
  }
  if (payload.data && Array.isArray(payload.data.transactions)) {
    payload.data.transactions = list;
    return payload;
  }
  if (payload.data && Array.isArray(payload.data.data)) {
    payload.data.data = list;
    return payload;
  }

  payload.data = list;
  payload.success = payload.success ?? true;
  return payload;
}

/* -------------------------------------------------------------------
 *                       ACTIONS (proxy propre)
 * ------------------------------------------------------------------- */

exports.getTransaction = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const userId = getUserId(req);
  const { id } = req.params;

  const base = String(targetService).replace(/\/+$/, "");
  const url = `${base}/transactions/${encodeURIComponent(id)}`;

  try {
    const response = await safeAxiosRequest({
      method: "get",
      url,
      headers: auditForwardHeaders(req),
      params: req.query,
      timeout: 10000,
    });

    const payload = response.data || {};
    const data = payload?.data || payload?.transaction || payload;

    if (data && typeof data === "object") {
      const normalized = normalizeTxForResponse(data, userId);
      if (payload?.data) payload.data = normalized;
      else if (payload?.transaction) payload.transaction = normalized;
      else return res.status(response.status).json(normalized);
    }

    return res.status(response.status).json(payload);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(url);
      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      "Erreur lors du proxy GET transaction";

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
    }

    logger.error?.("[Gateway][TX] Erreur GET transaction:", { status, error, provider, transactionId: id });
    return res.status(status).json({ success: false, error });
  }
};

exports.listTransactions = async (req, res) => {
  const provider = resolveProvider(req, "paynoval");
  const targetService = PROVIDER_TO_SERVICE[provider];

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Non autorisé." });
  }

  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  } catch {}

  const cacheKey = _listTxCacheKey({ userId, provider, query: req.query });

  const cached = listTxCache.get(cacheKey);
  if (cached && cached.body) return res.status(cached.status || 200).json(cached.body);

  const inflight = listTxInflight.get(cacheKey);
  if (inflight && typeof inflight.then === "function") {
    try {
      const out = await inflight;
      return res.status(out.status || 200).json(out.body);
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

    const base = String(targetService).replace(/\/+$/, "");
    const url = `${base}/transactions`;

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
            warning: err.isCloudflareChallenge ? "provider_cloudflare_challenge" : "provider_cooldown",
            retryAfterSec: cd?.retryAfterSec,
          },
        };
      }

      const status = err.response?.status || 502;
      let error =
        err.response?.data?.error ||
        err.response?.data?.message ||
        (typeof err.response?.data === "string" ? err.response.data : null) ||
        "Erreur lors du proxy GET transactions";

      if (status === 429) error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants.";

      logger.error?.("[Gateway][TX] Erreur GET transactions (no DB fallback)", { status, error, provider });

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
    const out = await promise;
    return res.status(out.status || 200).json(out.body);
  } catch (_e) {
    listTxCache.delete(cacheKey);
    return res.status(500).json({ success: false, error: "Erreur interne (listTransactions)." });
  } finally {
    listTxInflight.delete(cacheKey);
  }
};





/**
 * POST /transactions/initiate
 * ✅ Routing basé sur providerSelected
 * ✅ OTP guard (dépôt MobileMoney -> PayNoval sur numéro différent)
 * ✅ Normalisation MobileMoney: funds/destination + metadata.provider
 * ✅ Proxy uniquement
 */
exports.initiateTransaction = async (req, res) => {
  // ✅ normalize mobilemoney provider mapping first
  normalizeMobileMoneyProviderInBody(req);

  const actionTx = String(req.body?.action || "send").toLowerCase();
  const funds = req.body?.funds;
  const destination = req.body?.destination;

  // 🔥 important: providerSelected doit être un "service key"
  // si le client envoie "wave", on le force à "mobilemoney" (service)
  let providerSelected = resolveProvider(req, computeProviderSelected(actionTx, funds, destination));
  if (MOBILEMONEY_PROVIDERS.has(String(providerSelected || "").toLowerCase())) {
    providerSelected = "mobilemoney";
  }

  // ✅ si funds/destination est mobilemoney, on route vers service mobilemoney
  if (String(funds || "").toLowerCase() === "mobilemoney" || String(destination || "").toLowerCase() === "mobilemoney") {
    providerSelected = "mobilemoney";
  }

  const targetService = PROVIDER_TO_SERVICE[providerSelected];
  const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
  const targetUrl = base ? base + "/transactions/initiate" : null;

  if (!targetUrl) return res.status(400).json({ success: false, error: "Provider (providerSelected) inconnu." });

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: "Non autorisé (utilisateur manquant)." });

  // ✅ Guard OTP : dépôt MobileMoney -> PayNoval sur un numéro différent
  try {
    const actionNorm = String(req.body?.action || "send").toLowerCase();
    const fundsNorm = String(req.body?.funds || "").toLowerCase();
    const destNorm = String(req.body?.destination || "").toLowerCase();

    if (actionNorm === "deposit" && fundsNorm === "mobilemoney" && destNorm === "paynoval") {
      const rawPhone = req.body?.phoneNumber || req.body?.toPhone || req.body?.phone || "";
      const country = req.body?.country || req.user?.country || req.user?.selectedCountry || "";

      const phoneE164 = normalizePhoneE164(rawPhone, country);

      if (!phoneE164) {
        return res.status(400).json({
          success: false,
          error:
            "Numéro de dépôt invalide. Format attendu: E.164 (ex: +2250700000000) ou numéro local valide selon le pays.",
          code: "PHONE_INVALID",
        });
      }

      // Même numéro que le user => OK sans trusted
      const userPhoneE164 = pickUserPrimaryPhoneE164(req.user, country);
      const isSameAsUser = userPhoneE164 && String(userPhoneE164) === String(phoneE164);

      if (!isSameAsUser) {
        let trusted = false;

        // 1) DB trusted (si Mongo + modèle dispo)
        const mongoUp = mongoose.connection.readyState === 1;
        if (mongoUp && TrustedDepositNumber) {
          try {
            const trustedDoc = await TrustedDepositNumber.findOne({
              userId,
              phoneE164,
              status: "trusted",
            }).lean();
            trusted = !!trustedDoc;
          } catch {
            trusted = false;
          }
        }

        if (!trusted) {
          // 2) status API
          const st = await fetchOtpStatus({ req, phoneE164, country });

          // trusted => upsert (si possible)
          if (st?.trusted) {
            if (mongoose.connection.readyState === 1 && TrustedDepositNumber) {
              try {
                await TrustedDepositNumber.updateOne(
                  { userId, phoneE164 },
                  {
                    $set: { userId, phoneE164, status: "trusted", verifiedAt: new Date(), updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() },
                  },
                  { upsert: true }
                );
              } catch {}
            }
          } else {
            if (String(st?.status || "").toLowerCase() === "pending") {
              return res.status(403).json({
                success: false,
                error: "Vérification SMS déjà en cours pour ce numéro. Entre le code reçu (ne relance pas l’OTP).",
                code: "PHONE_VERIFICATION_PENDING",
                otpStatus: { status: "pending", skipStart: true },
                nextStep: {
                  status: "/api/v1/phone-verification/status",
                  start: "/api/v1/phone-verification/start",
                  verify: "/api/v1/phone-verification/verify",
                  phoneNumber: phoneE164,
                  country,
                  skipStart: true,
                },
              });
            }

            return res.status(403).json({
              success: false,
              error: "Ce numéro n’est pas vérifié. Vérifie d’abord le numéro par SMS avant de déposer.",
              code: "PHONE_NOT_TRUSTED",
              otpStatus: { status: st?.status || "none", skipStart: false },
              nextStep: {
                status: "/api/v1/phone-verification/status",
                start: "/api/v1/phone-verification/start",
                verify: "/api/v1/phone-verification/verify",
                phoneNumber: phoneE164,
                country,
                skipStart: false,
              },
            });
          }
        }
      }

      // ✅ réécriture E.164
      req.body.phoneNumber = phoneE164;
    }
  } catch (e) {
    logger?.warn?.("[Gateway][OTP] trusted check failed", { message: e?.message });
    return res.status(500).json({ success: false, error: "Erreur vérification numéro." });
  }

  // ✅ harmonise sécurité: accepte question/securityCode (legacy) ou securityQuestion/securityAnswer (new)
  try {
    const b = req.body || {};
    b.securityQuestion = b.securityQuestion || b.question || null;
    b.securityAnswer = b.securityAnswer || b.securityCode || null; // TX Core hash
    req.body = b;
  } catch {}

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const payload = response.data || {};
    const data = payload?.data || payload?.transaction || payload;

    if (data && typeof data === "object") {
      const normalized = normalizeTxForResponse(data, userId);
      if (payload?.data) payload.data = normalized;
      else if (payload?.transaction) payload.transaction = normalized;
      else return res.status(response.status).json(normalized);
    }

    return res.status(response.status).json(payload);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(targetUrl);
      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      "Erreur interne provider";

    if (status === 429) {
      error =
        "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
    }

    return res.status(status).json({ success: false, error });
  }
};

/**
 * Helper commun confirm/cancel + normalisation
 */
async function forwardSimpleAction(req, res, action) {
  // ✅ normalize mobilemoney provider mapping
  normalizeMobileMoneyProviderInBody(req);

  // 🔥 important : pour confirm/cancel on accepte provider/providerSelected dans le body
  let provider = resolveProvider(req, "paynoval");
  if (MOBILEMONEY_PROVIDERS.has(String(provider || "").toLowerCase())) provider = "mobilemoney";

  const targetService = PROVIDER_TO_SERVICE[provider];
  const base = targetService ? String(targetService).replace(/\/+$/, "") : null;
  const targetUrl = base ? base + `/transactions/${action}` : null;

  if (!targetUrl) return res.status(400).json({ success: false, error: "Provider (destination) inconnu." });

  const userId = getUserId(req);

  // ✅ harmonise sécurité confirm: securityAnswer (new) ou securityCode (legacy)
  if (action === "confirm") {
    try {
      const b = req.body || {};
      b.securityAnswer = b.securityAnswer || b.securityCode || null;
      req.body = b;
    } catch {}
  }

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url: targetUrl,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    const payload = response.data || {};
    const data = payload?.data || payload?.transaction || payload;

    if (data && typeof data === "object") {
      const normalized = normalizeTxForResponse(data, userId);
      if (payload?.data) payload.data = normalized;
      else if (payload?.transaction) payload.transaction = normalized;
      else return res.status(response.status).json(normalized);
    }

    return res.status(response.status).json(payload);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(targetUrl);
      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      `Erreur interne provider (${action})`;

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants.";
    }

    return res.status(status).json({ success: false, error });
  }
}

exports.confirmTransaction = async (req, res) => forwardSimpleAction(req, res, "confirm");
exports.cancelTransaction = async (req, res) => forwardSimpleAction(req, res, "cancel");

// Admin proxies
exports.refundTransaction = async (req, res) => forwardTransactionProxy(req, res, "refund");
exports.reassignTransaction = async (req, res) => forwardTransactionProxy(req, res, "reassign");
exports.validateTransaction = async (req, res) => forwardTransactionProxy(req, res, "validate");
exports.archiveTransaction = async (req, res) => forwardTransactionProxy(req, res, "archive");
exports.relaunchTransaction = async (req, res) => forwardTransactionProxy(req, res, "relaunch");

async function forwardTransactionProxy(req, res, action) {
  // ✅ normalize mobilemoney provider mapping
  normalizeMobileMoneyProviderInBody(req);

  let provider = resolveProvider(req, "paynoval");
  if (MOBILEMONEY_PROVIDERS.has(String(provider || "").toLowerCase())) provider = "mobilemoney";

  const targetService = PROVIDER_TO_SERVICE[provider];

  if (!targetService) {
    return res.status(400).json({ success: false, error: `Provider inconnu: ${provider}` });
  }

  const url = String(targetService).replace(/\/+$/, "") + `/transactions/${action}`;
  const userId = getUserId(req);

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url,
      data: req.body,
      headers: auditForwardHeaders(req),
      timeout: 15000,
    });

    // ✅ normalisation si payload contient une tx
    const payload = response.data || {};
    const data = payload?.data || payload?.transaction || null;

    if (data && typeof data === "object") {
      const normalized = normalizeTxForResponse(data, userId);
      if (payload?.data) payload.data = normalized;
      else if (payload?.transaction) payload.transaction = normalized;
    }

    return res.status(response.status).json(payload);
  } catch (err) {
    if (err.isProviderCooldown || err.isCloudflareChallenge) {
      const cd = err.cooldown || getProviderCooldown(url);
      return res.status(503).json({
        success: false,
        error:
          "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
        details: err.isCloudflareChallenge ? "cloudflare_challenge" : "provider_cooldown",
        retryAfterSec: cd?.retryAfterSec,
      });
    }

    const status = err.response?.status || 502;
    let error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      `Erreur proxy ${action}`;

    if (status === 429) {
      error = "Trop de requêtes vers le service de paiement. Merci de patienter quelques instants avant de réessayer.";
    }

    logger.error?.(`[Gateway][TX] Erreur ${action}:`, { status, error, provider });
    return res.status(status).json({ success: false, error });
  }
}

/**
 * ✅ Route interne log (technique)
 * - Dépend de Mongo: si Mongo KO => 503.
 */
exports.logInternalTransaction = async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ success: false, error: "MongoDB non connecté (log interne indisponible)." });
  }

  let Transaction = null;
  try {
    Transaction = reqAny(["../src/models/Transaction", "../models/Transaction"]);
  } catch {
    return res.status(500).json({ success: false, error: "Model Transaction introuvable (log interne)." });
  }

  try {
    const now = new Date();
    const userId = getUserId(req) || req.body?.userId || null;
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId manquant pour loguer la transaction." });
    }

    const { provider = "paynoval", amount, status = "confirmed", currency, reference, meta = {} } = req.body || {};

    const numAmount = Number(amount);
    if (!numAmount || Number.isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, error: "amount invalide ou manquant." });
    }

    const countryHint =
      req.body?.country || meta?.country || meta?.recipientInfo?.country || meta?.recipientInfo?.pays || "";

    const legacyCurrency = normalizeCurrencyCode(currency, countryHint) || null;

    // ✅ optional: normalise provider mobilemoney
    const outMeta = typeof meta === "object" && meta ? { ...meta } : {};
    if (outMeta.provider && MOBILEMONEY_PROVIDERS.has(String(outMeta.provider).toLowerCase())) {
      // ok
    }

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

    const out = normalizeTxForResponse(doc.toObject ? doc.toObject() : doc, userId);
    return res.status(201).json({ success: true, data: out });
  } catch (err) {
    logger.error?.("[Gateway][TX] logInternalTransaction error", { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Erreur lors de la création du log interne." });
  }
};
