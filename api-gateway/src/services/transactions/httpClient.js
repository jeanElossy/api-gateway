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
const { createCircuitBreaker } = require("../circuitBreaker");

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

/**
 * ═══ DU CACHE D'ÉCHEC AU DISJONCTEUR ══════════════════════════════════════
 *
 * Ce fichier tenait un `LRUCache` de fournisseurs « en cooldown », alimenté
 * UNIQUEMENT sur un 429 ou un défi Cloudflare. Deux défauts opposés :
 *
 *   • si tx-core devenait injoignable (connexion refusée, délai dépassé, 502),
 *     rien ne se déclenchait : chaque requête repartait vers un service mort et
 *     payait le délai en entier. À dix requêtes par seconde et 15 s de délai,
 *     cent cinquante requêtes s'empilent — la panne du service aval devient une
 *     panne de la passerelle ;
 *   • un SEUL 429 coupait le fournisseur cinq minutes, pour tout le monde.
 *
 * `services/circuitBreaker.js` remplace les deux par une machine à trois états,
 * avec seuil, sonde unique à la réouverture et recul progressif. Le point le
 * plus important y est expliqué : **une 4xx ne compte pas comme un échec du
 * fournisseur** — sinon ce sont les utilisateurs qui ouvrent le disjoncteur.
 */
const FAIL_COOLDOWN_MS = Number(
  process.env.PROVIDER_FAIL_COOLDOWN_MS || 30_000
);

const breaker = createCircuitBreaker({
  failureThreshold: Number(process.env.PROVIDER_FAIL_THRESHOLD || 5),
  openMs: FAIL_COOLDOWN_MS,
  maxOpenMs: Number(process.env.PROVIDER_MAX_OPEN_MS || 5 * 60_000),
  logger,
});

function getServiceKeyFromUrl(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return String(url || "").slice(0, 120);
  }
}

/**
 * Signale un échec au disjoncteur. Le nom est conservé : plusieurs modules
 * l'importent, et la forme de retour n'a pas changé.
 */
function setProviderCooldown(url, reason, extra = {}) {
  const key = getServiceKeyFromUrl(url);

  breaker.onFailure(key, {
    status: extra.status,
    transportError: extra.transportError === true,
    reason: reason || "provider_unavailable",
    retryAfterSec: extra.retryAfterSec,
  });

  const st = breaker.inspect(key);

  return {
    key,
    reason: reason || "provider_unavailable",
    state: st.state,
    nextTryAt: st.nextTryAt,
    retryAfterSec: st.retryAfterSec || Math.ceil(FAIL_COOLDOWN_MS / 1000),
    ...extra,
  };
}

/**
 * Lecture seule : le fournisseur est-il actuellement coupé ?
 *
 * ⚠️ N'utilise PAS `canRequest` : cette fonction est appelée par
 * `orchestrator.js` à titre informatif, et `canRequest` **consomme** une sonde
 * en demi-ouvert. Consommer la sonde ici la volerait à la vraie requête, qui
 * serait alors refusée alors que le disjoncteur voulait justement la laisser
 * passer.
 */
function getProviderCooldown(url) {
  const key = getServiceKeyFromUrl(url);
  const st = breaker.inspect(key);

  if (st.state !== "open") return null;

  return {
    key,
    reason: st.reason || "provider_unavailable",
    state: st.state,
    nextTryAt: st.nextTryAt,
    retryAfterSec: st.retryAfterSec,
  };
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

  const circuitKey = getServiceKeyFromUrl(finalOpts.url);
  const gate = breaker.canRequest(circuitKey);

  if (!gate.allowed) {
    const cd = {
      key: circuitKey,
      reason: gate.reason || "provider_unavailable",
      state: gate.state,
      retryAfterSec: gate.retryAfterSec,
      nextTryAt: Date.now() + gate.retryAfterSec * 1000,
    };

    /**
     * On échoue ICI, sans toucher au réseau. C'est tout le gain : une
     * microseconde au lieu du délai d'expiration, et le service aval cesse
     * d'être matraqué pendant qu'il tente de se relever.
     */
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

    breaker.onSuccess(circuitKey);

    return response;
  } catch (err) {
    const status = err.response?.status || err.status || 502;
    const data = err.response?.data || null;
    const message = err.message || "Erreur axios inconnue";

    const preview = typeof data === "string" ? data.slice(0, 300) : data;
    const isCf =
      err.isCloudflareChallenge || isCloudflareChallengeResponse(err.response);
    const isRateLimited = status === 429;

    /**
     * ⚠️ TOUT échec est signalé au disjoncteur, pas seulement 429 et
     * Cloudflare. C'est le défaut central de la version précédente : une
     * connexion refusée ou un délai dépassé ne déclenchait rien, donc la
     * passerelle continuait d'appeler un service mort.
     *
     * C'est `countsAsFailure` (module `circuitBreaker`) qui tranche ensuite ce
     * qui incrimine vraiment le fournisseur — et une 4xx n'en fait pas partie :
     * ce sont les utilisateurs qui les provoquent, les compter ferait ouvrir le
     * disjoncteur sur un fournisseur en parfaite santé.
     */
    if (!err.isProviderCooldown) {
      const ra = Number(err.response?.headers?.["retry-after"]);

      /** Aucune réponse HTTP = la requête n'a pas abouti : transport. */
      const transportError = !err.response;

      const reason = isCf
        ? "cloudflare_challenge"
        : isRateLimited
        ? "rate_limited"
        : transportError
        ? `transport_${err.code || "error"}`
        : `http_${status}`;

      const cd3 = setProviderCooldown(finalOpts.url, reason, {
        retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined,
        status: err.response ? status : undefined,
        transportError,
      });

      if (cd3.state === "open") {
        logger.warn?.("[Gateway][Axios] disjoncteur ouvert", {
          url: finalOpts.url,
          status,
          reason: cd3.reason,
          retryAfterSec: cd3.retryAfterSec,
        });
      }

      err.cooldown = cd3.state === "open" ? cd3 : null;
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

  /** Exposé pour les journaux d'exploitation, les métriques et les tests. */
  breaker,
};