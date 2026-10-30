"use strict";

/**
 * QUI A LE DROIT D'AJOUTER UNE ADRESSE À `X-Forwarded-For`
 * ============================================================================
 *
 * `trust proxy` valait 1 : un seul saut, le répartiteur Render. Or Render reçoit
 * son trafic par Cloudflare (journal de production du 2026-10-30 : un compteur
 * au nom de 104.22.72.4). Le dernier saut est alors un serveur de Cloudflare :
 * `req.ip` n'est plus le visiteur, et tous ceux qui passent par ce serveur
 * partagent leurs compteurs de limitation.
 *
 * Passer à 2 sauts serait faux dès qu'une requête n'emprunte pas Cloudflare : le
 * client pourrait alors choisir son adresse. On fait donc confiance au saut 0
 * (le répartiteur) puis aux seules adresses de Cloudflare, et la marche s'arrête
 * à la première adresse inconnue : le visiteur. Ce qu'un client écrit lui-même
 * dans l'en-tête se trouve à gauche de cette adresse, jamais lu.
 *
 * Plages publiées sur https://www.cloudflare.com/ips/.
 */

const net = require("net");

const CLOUDFLARE_V4 = [
  ["173.245.48.0", 20],
  ["103.21.244.0", 22],
  ["103.22.200.0", 22],
  ["103.31.4.0", 22],
  ["141.101.64.0", 18],
  ["108.162.192.0", 18],
  ["190.93.240.0", 20],
  ["188.114.96.0", 20],
  ["197.234.240.0", 22],
  ["198.41.128.0", 17],
  ["162.158.0.0", 15],
  ["104.16.0.0", 13],
  ["104.24.0.0", 14],
  ["172.64.0.0", 13],
  ["131.0.72.0", 22],
];

const CLOUDFLARE_V6 = [
  ["2400:cb00::", 32],
  ["2606:4700::", 32],
  ["2803:f800::", 32],
  ["2405:b500::", 32],
  ["2405:8100::", 32],
  ["2a06:98c0::", 29],
  ["2c0f:f248::", 32],
];

const cloudflare = new net.BlockList();
for (const [address, prefix] of CLOUDFLARE_V4) cloudflare.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of CLOUDFLARE_V6) cloudflare.addSubnet(address, prefix, "ipv6");

function isCloudflare(address) {
  const ip = String(address || "").replace(/^::ffff:/i, "");
  const family = net.isIP(ip);
  if (family === 4) return cloudflare.check(ip, "ipv4");
  if (family === 6) return cloudflare.check(ip, "ipv6");
  return false;
}

function trustProxy(address, hop) {
  return hop === 0 || isCloudflare(address);
}

module.exports = { trustProxy, isCloudflare };
