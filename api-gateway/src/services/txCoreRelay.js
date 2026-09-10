"use strict";

/**
 * ============================================================================
 * RELAIS VERS TX-CORE — CE QUE FAIT UNE PASSERELLE
 * ============================================================================
 *
 * ── Le principe, celui de Stripe, PayPal et Adyen ───────────────────────────
 *
 * Une passerelle fait cinq choses, et pas une de plus :
 *
 *   1. terminaison TLS et routage ;
 *   2. VÉRIFICATION d'un jeton — pas le chargement d'un utilisateur ;
 *   3. limitation de débit, quotas, filtrage ;
 *   4. validation de forme, corrélation (`x-request-id`, `Idempotency-Key`) ;
 *   5. observabilité et versionnage d'API.
 *
 * Elle ne décide d'aucun prix, n'évalue aucun risque métier, ne possède aucun
 * domaine et ne détient aucune base. La raison n'est pas esthétique : le bord
 * est la surface la plus exposée d'Internet, et une base y place les règles
 * tarifaires derrière la seule porte que le monde entier peut frapper.
 *
 * Corollaire, plus important encore : **les dépendances descendent**. Bord →
 * services → moteur. Jamais l'inverse. Avant le 2026-09-10, Tx-Core venait
 * chercher ses devis dans la passerelle : une panne du bord arrêtait les
 * virements de l'intérieur du moteur.
 *
 * ── Ce qu'un relais ne doit JAMAIS faire ────────────────────────────────────
 *
 * Réinterpréter la réponse. Un 404 « aucun barème ne couvre ce corridor » et un
 * 503 « taux de change indisponible » portent chacun une information que
 * l'appelant doit recevoir telle quelle. Les fondre en un 502 générique perd le
 * diagnostic ; les transformer en 200 avec une valeur par défaut ferait
 * accepter une opération à un tarif que personne n'a décidé (règle B.2).
 *
 * ── Ce qu'il transporte ─────────────────────────────────────────────────────
 *
 * L'IDENTITÉ ÉTABLIE, dans `x-user-id` et `x-user-role`. C'est le bord qui
 * prouve qui appelle et avec quel droit ; le moteur reçoit le verdict et ne le
 * refait pas. Ces en-têtes ne valent que parce que le canal porte le jeton
 * interne — sans lui, ils seraient purement déclaratifs.
 */

const axios = require("axios");
const crypto = require("crypto");
const logger = require("../logger");

const TIMEOUT_MS = Number(process.env.TX_CORE_RELAY_TIMEOUT_MS || 12000);

/**
 * En-têtes que la passerelle ne relaie JAMAIS.
 *
 * `host` et `content-length` décrivent le saut précédent et fausseraient le
 * suivant. `authorization` et les jetons internes sont RÉÉMIS par le relais :
 * transmettre celui du client laisserait Tx-Core croire qu'il parle au client,
 * alors qu'il parle à la passerelle.
 */
const EN_TETES_ECARTES = Object.freeze([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "authorization",
  "cookie",
  "x-internal-token",
  "x-user-id",
  "x-user-role",
]);

function baseTxCore() {
  const brute =
    process.env.TRANSACTIONS_API_BASE_URL ||
    process.env.TRANSACTIONS_SERVICE_URL ||
    process.env.TX_CORE_URL ||
    process.env.TXCORE_URL ||
    process.env.SERVICE_PAYNOVAL_URL ||
    "";

  return String(brute).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function jetonInterne() {
  return String(
    process.env.TX_CORE_INTERNAL_TOKEN ||
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      ""
  ).trim();
}

function enTetesTransmis(req) {
  const out = {};

  for (const [nom, valeur] of Object.entries(req.headers || {})) {
    if (EN_TETES_ECARTES.includes(String(nom).toLowerCase())) continue;
    if (valeur === undefined) continue;
    out[nom] = valeur;
  }

  return out;
}

/**
 * Relaie la requête courante vers Tx-Core sous `prefixeCible`.
 *
 * Le sous-chemin est repris de `req.path`, si bien qu'un routeur monté sur
 * `/api/v1/fees` relaie `/simulate` vers `<prefixeCible>/simulate` sans qu'on
 * ait à énumérer les chemins des deux côtés — une énumération en double finit
 * toujours par diverger.
 */
function relayerVers(prefixeCible) {
  return async function relais(req, res) {
    const base = baseTxCore();
    const jeton = jetonInterne();

    if (!base || !jeton) {
      /**
       * Règle B.2 : on échoue en FERMETURE. Sans cible ni jeton, on ne sert pas
       * une valeur approximative — on refuse, et on le dit.
       */
      logger.error("[relay] Tx-Core non configuré", {
        cible: prefixeCible,
        urlPresente: Boolean(base),
        jetonPresent: Boolean(jeton),
      });

      return res.status(503).json({
        success: false,
        code: "TX_CORE_UNCONFIGURED",
        error: "Service indisponible.",
      });
    }

    const reqId =
      req.headers["x-request-id"] ||
      req.headers["x-correlation-id"] ||
      crypto.randomUUID();

    const sousChemin = req.path === "/" ? "" : req.path;
    const url = `${base}${prefixeCible}${sousChemin}`;

    try {
      const reponse = await axios({
        method: req.method,
        url,
        params: req.query,
        data: ["GET", "HEAD", "DELETE"].includes(req.method)
          ? undefined
          : req.body,
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          ...enTetesTransmis(req),
          Accept: "application/json",
          "x-internal-token": jeton,
          "x-request-id": reqId,
          ...(req.user?._id ? { "x-user-id": String(req.user._id) } : {}),
          ...(req.user?.role ? { "x-user-role": String(req.user.role) } : {}),
        },
      });

      /** Statut et corps VERBATIM. Voir l'en-tête du fichier. */
      return res.status(reponse.status).json(reponse.data);
    } catch (err) {
      const timeout =
        err.code === "ECONNABORTED" ||
        String(err.message || "").toLowerCase().includes("timeout");

      logger.error("[relay] Tx-Core injoignable", {
        cible: prefixeCible,
        chemin: sousChemin,
        timeout,
        message: err?.message,
        reqId,
      });

      return res.status(timeout ? 504 : 502).json({
        success: false,
        code: timeout ? "TX_CORE_TIMEOUT" : "TX_CORE_UNAVAILABLE",
        error: "Service momentanément indisponible.",
      });
    }
  };
}

module.exports = { relayerVers, EN_TETES_ECARTES, baseTxCore, jetonInterne };
