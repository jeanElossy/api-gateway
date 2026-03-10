"use strict";

/**
 * --------------------------------------------------------------------------
 * Safe Axios Request
 * --------------------------------------------------------------------------
 * - ajoute un user-agent gateway
 * - détecte rate limit / Cloudflare challenge
 * - met en cooldown temporaire un provider
 * --------------------------------------------------------------------------
 */

const axios = require("axios");
const { LRUCache } = require("lru-cache");

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
const logger = reqAny([
  "../../src/logger",
  "../../logger",
  "../../src/utils/logger",
  "../../utils/logger",
]);

const GATEWAY_USER_AGENT =
  config.gatewayUserAgent || "PayNoval-Gateway/1.0 (+https://paynoval.com)";

const FAIL_COOLDOWN_MS = Number(
  process.env.PROVIDER_FAIL_COOLDOWN_MS || 5 * 60 * 1000
);
const FAIL_CACHE_MAX = Number(process.env.PROVIDER_FAIL_CACHE_MAX || 200);

const providerFail = new LRUCache({
  max: FAIL_CACHE_MAX,
  ttl: FAIL_COOLDOWN_MS,
});

function getServiceKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return String(url || "").slice(0, 120);
  }
}

function setProviderCooldown(url, reason, extra = {}) {
  const key = getServiceKeyFromUrl(url);
  const now = Date.now();

  const retryAfterSec = Number(extra.retryAfterSec);
  const cdMs =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : FAIL_COOLDOWN_MS;

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

async function safeAxiosRequest(opts) {
  const finalOpts = { ...opts };

  if (!finalOpts.timeout) finalOpts.timeout = 15000;
  finalOpts.method = finalOpts.method || "get";

  finalOpts.headers = { ...(finalOpts.headers || {}) };
  const hasUA =
    finalOpts.headers["User-Agent"] || finalOpts.headers["user-agent"];
  if (!hasUA) finalOpts.headers["User-Agent"] = GATEWAY_USER_AGENT;

  const cd = getProviderCooldown(finalOpts.url);
  if (cd) {
    const e = new Error(`Provider cooldown (${cd.retryAfterSec}s)`);
    e.status = 503;
    e.isProviderCooldown = true;
    e.cooldown = cd;
    e.response = {
      status: 503,
      data: { error: "provider_cooldown", cooldown: cd },
    };
    throw e;
  }

  try {
    const response = await axios(finalOpts);

    if (isCloudflareChallengeResponse(response)) {
      const cd2 = setProviderCooldown(finalOpts.url, "cloudflare_challenge", {
        retryAfterSec: 60,
      });

      const e = new Error("Cloudflare challenge détecté");
      e.status = 503;
      e.response = response;
      e.isCloudflareChallenge = true;
      e.cooldown = cd2;
      throw e;
    }

    const key = getServiceKeyFromUrl(finalOpts.url);
    providerFail.delete(key);

    return response;
  } catch (err) {
    const status = err.response?.status || err.status || 502;
    const data = err.response?.data || null;
    const message = err.message || "Erreur axios inconnue";

    const preview = typeof data === "string" ? data.slice(0, 300) : data;
    const isCf =
      err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
    const isRateLimited = status === 429;

    if (isRateLimited || isCf) {
      const ra = Number(err.response?.headers?.["retry-after"]);
      const cd3 = setProviderCooldown(
        finalOpts.url,
        isCf ? "cloudflare_challenge" : "rate_limited",
        {
          retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
          status,
        }
      );

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
    e.status = status;
    e.response = err.response;
    e.isCloudflareChallenge = isCf;
    e.isRateLimited = isRateLimited;
    e.isProviderCooldown = !!err.isProviderCooldown;
    e.cooldown = err.cooldown || null;
    throw e;
  }
}

module.exports = {
  safeAxiosRequest,
  getProviderCooldown,
  setProviderCooldown,
  isCloudflareChallengeResponse,
  getServiceKeyFromUrl,
};