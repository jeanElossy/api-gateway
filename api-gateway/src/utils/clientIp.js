"use strict";

/**
 * ============================================================================
 * ADRESSE IP DU CLIENT AU BORD DU RÉSEAU — UNE SEULE DÉFINITION
 * ============================================================================
 *
 * Constat du 2026-10-08 : les limiteurs de la passerelle prenaient pour clé
 * `cf-connecting-ip`, puis l'entrée GAUCHE de `X-Forwarded-For`, puis
 * `x-real-ip` — trois en-têtes que le CLIENT écrit (aucun Cloudflare devant).
 * Changer l'en-tête à chaque requête donnait un compteur neuf : la limite de
 * connexion ne protégeait plus rien.
 *
 * Seule source fiable ici : `req.ip`, calculée par Express selon `trust proxy`
 * (= 1 saut, le répartiteur Render, qui AJOUTE l'adresse réelle à droite de la
 * chaîne). Pour les clés de limitation, une adresse IPv6 est ramenée à son
 * préfixe /64 (un client en possède des milliards), comme `ipKeyGenerator`
 * d'express-rate-limit 7.
 */

const net = require("net");
const { normalizeIp } = require("./clientIpAttestation");

function getClientIp(req) {
  return normalizeIp(req?.ip || req?.socket?.remoteAddress) || "unknown";
}

function expandIPv6(ip) {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const missing = 8 - left.length - right.length;
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right] : left;
  return groups.map((g) => g.padStart(4, "0").toLowerCase());
}

function rateLimitIpKey(req) {
  const ip = getClientIp(req);
  return net.isIPv6(ip) ? `${expandIPv6(ip).slice(0, 4).join(":")}::/64` : ip;
}

module.exports = { getClientIp, rateLimitIpKey, expandIPv6 };
