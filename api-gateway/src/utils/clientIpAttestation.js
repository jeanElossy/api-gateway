"use strict";

/**
 * ============================================================================
 * ATTESTATION DE L'IP CLIENTE — LE BORD DU RÉSEAU LA DÉTERMINE, UNE FOIS
 * ============================================================================
 *
 * Pratique de référence : Cloudflare `CF-Connecting-IP`, Envoy
 * `x-envoy-external-address`, l'edge de Stripe. Seul le premier saut sous notre
 * contrôle connaît l'adresse réelle du client ; les services situés derrière ne
 * doivent JAMAIS la redéduire de `X-Forwarded-For`, dont l'entrée la plus à
 * gauche est écrite par le client lui-même.
 *
 * La passerelle calcule l'IP (`req.ip`, `trust proxy` = 1 saut Render) et la
 * transmet au backend principal dans trois en-têtes, SIGNÉS :
 *
 *   X-PayNoval-Client-IP       l'adresse
 *   X-PayNoval-Client-IP-TS    l'horodatage (ms) de la signature
 *   X-PayNoval-Client-IP-Sig   HMAC-SHA256(k, "v1|ip|ts|METHOD|path")
 *
 * La clé `k` est DÉRIVÉE du jeton interne (séparation de domaine) : le jeton
 * lui-même ne voyage jamais sur une requête publique relayée — ce serait le
 * « député confus » déjà écarté le 2026-09-17. Connaître une signature
 * n'autorise rien : elle n'atteste qu'une adresse, pour une requête précise,
 * pendant une minute.
 *
 * Module PUR (crypto natif seulement), dupliqué à l'identique dans
 * `paynoval-backend/utils/clientIp.js` — le test croisé de chaque dépôt fige le
 * même vecteur.
 */

const crypto = require("crypto");

const HEADER_IP = "x-paynoval-client-ip";
const HEADER_TS = "x-paynoval-client-ip-ts";
const HEADER_SIG = "x-paynoval-client-ip-sig";
const ATTESTATION_HEADERS = Object.freeze([HEADER_IP, HEADER_TS, HEADER_SIG]);

const KEY_INFO = "paynoval/client-ip-attestation/v1";

function deriveAttestationKey(secret) {
  const s = String(secret || "");
  if (!s) return null;
  return crypto.createHmac("sha256", s).update(KEY_INFO).digest();
}

function canonicalPayload({ ip, ts, method, path }) {
  return `v1|${ip}|${ts}|${String(method || "").toUpperCase()}|${path}`;
}

function signClientIp({ key, ip, ts, method, path }) {
  return crypto.createHmac("sha256", key).update(canonicalPayload({ ip, ts, method, path })).digest("hex");
}

/** Normalise une adresse : retire le préfixe IPv4-mappé, borne la longueur. */
function normalizeIp(raw) {
  const ip = String(raw || "").trim().replace(/^::ffff:/i, "");
  if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  return ip;
}

/**
 * En-têtes à poser sur la requête relayée, ou `null` s'il n'y a ni clé ni IP
 * exploitable (le backend retombera alors sur sa propre lecture, et le dira).
 */
function buildAttestationHeaders({ key, ip, method, path, now = Date.now() }) {
  const cleanIp = normalizeIp(ip);
  if (!key || !cleanIp) return null;

  const ts = String(now);
  return {
    [HEADER_IP]: cleanIp,
    [HEADER_TS]: ts,
    [HEADER_SIG]: signClientIp({ key, ip: cleanIp, ts, method, path }),
  };
}

module.exports = {
  HEADER_IP,
  HEADER_TS,
  HEADER_SIG,
  ATTESTATION_HEADERS,
  KEY_INFO,
  deriveAttestationKey,
  canonicalPayload,
  signClientIp,
  normalizeIp,
  buildAttestationHeaders,
};
