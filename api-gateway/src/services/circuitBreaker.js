"use strict";

/**
 * DISJONCTEUR
 * =============================================================================
 *
 * ═══ CE QUI EXISTAIT, ET CE QUI MANQUAIT ═════════════════════════════════
 *
 * `httpClient.js` posait un « cooldown » sur un fournisseur, mais **uniquement**
 * sur un 429 ou un défi Cloudflare. Deux défauts opposés en découlaient :
 *
 *   • TROP PEU. Si tx-core est injoignable — connexion refusée, délai dépassé,
 *     502 — rien ne se déclenchait. Chaque requête entrante repartait vers un
 *     service mort et payait le délai d'expiration en entier. À dix requêtes par
 *     seconde et 15 s de délai, cent cinquante requêtes s'empilent en attente :
 *     la panne du service aval devient une panne de la passerelle. C'est
 *     l'effondrement en cascade, et c'est exactement ce qu'un disjoncteur existe
 *     pour empêcher.
 *
 *   • TROP. Un SEUL 429 coupait le fournisseur pendant cinq minutes, pour tout
 *     le monde. Un pic passager devenait une indisponibilité franche.
 *
 * ═══ LES TROIS ÉTATS ══════════════════════════════════════════════════════
 *
 *   FERMÉ      — tout passe. On compte les échecs consécutifs.
 *   OUVERT     — tout est refusé immédiatement, sans toucher au réseau. C'est
 *                là qu'est le gain : on échoue en une microseconde au lieu de
 *                quinze secondes, et le service aval cesse d'être matraqué
 *                pendant qu'il essaie de se relever.
 *   DEMI-OUVERT — après le délai, UNE seule requête sert de sonde. Succès →
 *                fermé. Échec → ouvert, avec un délai plus long.
 *
 * La sonde unique compte : laisser passer tout le trafic à la réouverture
 * réabattrait le service qui vient à peine de revenir.
 *
 * ═══ CE QUI COMPTE COMME UN ÉCHEC — LE PIÈGE PRINCIPAL ═══════════════════
 *
 * ⚠️ **Une erreur 4xx n'est PAS un échec du fournisseur.**
 *
 * 400, 401, 403, 404, 422 disent que la REQUÊTE était mauvaise, pas que le
 * service l'est. Les compter ferait ouvrir le disjoncteur à cause des
 * utilisateurs eux-mêmes : quelques centaines de requêtes malformées, et un
 * fournisseur en parfaite santé est coupé pour tout le monde. C'est l'erreur
 * classique de mise en œuvre d'un disjoncteur.
 *
 * Comptent comme échecs : les erreurs de transport (connexion refusée, DNS,
 * délai dépassé), les 5xx, le 429, et le défi Cloudflare.
 *
 * ═══ RECUL PROGRESSIF ════════════════════════════════════════════════════
 *
 * Chaque réouverture ratée double le délai, jusqu'à un plafond. Un incident
 * long ne se traduit donc pas par une sonde toutes les cinq minutes
 * indéfiniment. `Retry-After`, quand le fournisseur le donne, l'emporte : il
 * sait mieux que nous.
 *
 * ═══ POURQUOI CE MODULE EST PUR ══════════════════════════════════════════
 *
 * L'horloge est **injectée**. Les transitions — seuil, ouverture, sonde,
 * réouverture, recul — se testent en faisant avancer un nombre, sans attendre
 * une seule seconde réelle et sans réseau.
 */

const STATE = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

const DEFAULTS = Object.freeze({
  /**
   * Échecs consécutifs avant ouverture. Cinq, pas un : un incident réel produit
   * des échecs en rafale, un incident passager non.
   */
  failureThreshold: 5,

  /** Durée de la première ouverture. */
  openMs: 30_000,

  /** Plafond du recul progressif. Au-delà, on ne sonde pas moins souvent. */
  maxOpenMs: 5 * 60_000,

  /** Sondes simultanées autorisées en demi-ouvert. Une seule, délibérément. */
  halfOpenProbes: 1,

  /** Succès consécutifs en demi-ouvert avant de refermer. */
  successThreshold: 1,
});

/** Codes qui n'incriminent PAS le fournisseur. Voir le bloc ci-dessus. */
function isClientFault(status) {
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 429;
}

/**
 * Un échec doit-il compter contre le fournisseur ?
 *
 * Fonction **pure**, et la plus importante du module : c'est elle qui empêche
 * les utilisateurs d'ouvrir le disjoncteur à la place du fournisseur.
 */
function countsAsFailure({ status = null, transportError = false } = {}) {
  if (transportError) return true;
  if (status === null || status === undefined) return true;
  if (isClientFault(status)) return false;

  return status === 429 || status >= 500;
}

function createCircuitBreaker(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = options.now || (() => Date.now());
  const logger = options.logger || null;

  /** clé (origine du fournisseur) → état */
  const circuits = new Map();

  function circuitFor(key) {
    let c = circuits.get(key);

    if (!c) {
      c = {
        key,
        state: STATE.CLOSED,
        failures: 0,
        successes: 0,
        openedAt: 0,
        nextTryAt: 0,
        openMs: cfg.openMs,
        probesInFlight: 0,
        lastReason: null,
      };

      circuits.set(key, c);
    }

    return c;
  }

  /**
   * L'appel est-il autorisé ?
   *
   * @returns {{ allowed: boolean, state: string, retryAfterSec: number,
   *             reason: string|null, probe: boolean }}
   */
  function canRequest(key) {
    const c = circuitFor(key);
    const t = now();

    if (c.state === STATE.OPEN) {
      if (t < c.nextTryAt) {
        return {
          allowed: false,
          state: c.state,
          retryAfterSec: Math.max(1, Math.ceil((c.nextTryAt - t) / 1000)),
          reason: c.lastReason,
          probe: false,
        };
      }

      // Le délai est écoulé : on passe en demi-ouvert et on laisse UNE sonde.
      c.state = STATE.HALF_OPEN;
      c.successes = 0;
      c.probesInFlight = 0;
    }

    if (c.state === STATE.HALF_OPEN) {
      if (c.probesInFlight >= cfg.halfOpenProbes) {
        /**
         * Une sonde est déjà partie. Les autres requêtes sont refusées : laisser
         * passer tout le trafic à la réouverture réabattrait le service qui
         * vient à peine de revenir.
         */
        return {
          allowed: false,
          state: c.state,
          retryAfterSec: Math.max(1, Math.ceil(c.openMs / 1000)),
          reason: c.lastReason,
          probe: false,
        };
      }

      c.probesInFlight += 1;

      return { allowed: true, state: c.state, retryAfterSec: 0, reason: null, probe: true };
    }

    return { allowed: true, state: c.state, retryAfterSec: 0, reason: null, probe: false };
  }

  function onSuccess(key) {
    const c = circuitFor(key);

    if (c.state === STATE.HALF_OPEN) {
      c.probesInFlight = Math.max(0, c.probesInFlight - 1);
      c.successes += 1;

      if (c.successes < cfg.successThreshold) return c.state;

      c.state = STATE.CLOSED;
      c.failures = 0;
      c.successes = 0;

      // Le recul est remis à zéro : le fournisseur est sain à nouveau.
      c.openMs = cfg.openMs;
      c.lastReason = null;

      logger?.info?.(`[breaker] ${key} refermé`);
      return c.state;
    }

    c.failures = 0;
    return c.state;
  }

  /**
   * @param {string} key
   * @param {object} info  `{ status, transportError, reason, retryAfterSec }`
   */
  function onFailure(key, info = {}) {
    const c = circuitFor(key);

    if (!countsAsFailure(info)) {
      /**
       * Erreur imputable à l'appelant. On ne compte pas — mais on ne remet pas
       * non plus le compteur à zéro : une 400 au milieu d'une série de 503 ne
       * doit pas effacer la série.
       */
      if (c.state === STATE.HALF_OPEN) c.probesInFlight = Math.max(0, c.probesInFlight - 1);
      return c.state;
    }

    c.lastReason = info.reason || (info.transportError ? "transport_error" : `http_${info.status}`);

    const explicit = Number(info.retryAfterSec);
    const hasExplicit = Number.isFinite(explicit) && explicit > 0;

    if (c.state === STATE.HALF_OPEN) {
      // La sonde a échoué : on rouvre, plus longtemps.
      c.probesInFlight = 0;
      c.openMs = Math.min(c.openMs * 2, cfg.maxOpenMs);
      return open(c, hasExplicit ? explicit * 1000 : c.openMs);
    }

    c.failures += 1;

    if (c.failures < cfg.failureThreshold && !hasExplicit) return c.state;

    /**
     * `Retry-After` l'emporte sur le seuil : quand le fournisseur dit
     * explicitement « reviens dans N secondes », insister est inutile et
     * aggrave sa situation.
     */
    return open(c, hasExplicit ? explicit * 1000 : c.openMs);
  }

  function open(c, durationMs) {
    const t = now();

    c.state = STATE.OPEN;
    c.openedAt = t;
    c.nextTryAt = t + durationMs;
    c.successes = 0;
    c.probesInFlight = 0;

    logger?.warn?.(
      `[breaker] ${c.key} OUVERT pendant ${Math.round(durationMs / 1000)} s ` +
        `(${c.lastReason}) — les appels sont refusés immédiatement au lieu ` +
        `d'attendre le délai d'expiration`
    );

    return c.state;
  }

  /** Lecture seule, pour les journaux, les métriques et les tests. */
  function inspect(key) {
    const c = circuits.get(key);
    if (!c) return { state: STATE.CLOSED, failures: 0, nextTryAt: 0, openMs: cfg.openMs };

    return {
      state: c.state,
      failures: c.failures,
      nextTryAt: c.nextTryAt,
      openMs: c.openMs,
      reason: c.lastReason,
      retryAfterSec: c.state === STATE.OPEN
        ? Math.max(1, Math.ceil((c.nextTryAt - now()) / 1000))
        : 0,
    };
  }

  function reset(key) {
    if (key) circuits.delete(key);
    else circuits.clear();
  }

  function snapshot() {
    return Array.from(circuits.keys()).map((k) => ({ key: k, ...inspect(k) }));
  }

  return { canRequest, onSuccess, onFailure, inspect, reset, snapshot, STATE, config: cfg };
}

module.exports = { createCircuitBreaker, countsAsFailure, isClientFault, STATE, DEFAULTS };
