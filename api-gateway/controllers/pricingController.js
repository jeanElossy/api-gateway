"use strict";

/**
 * ============================================================================
 * TARIFICATION — LA PASSERELLE RELAIE, ELLE NE CALCULE PLUS
 * ============================================================================
 *
 * ── Ce que ce fichier contenait ─────────────────────────────────────────────
 *
 * 617 lignes de moteur de devis : sélection du barème, application de la marge
 * de change, conversion en devise d'administration, pose du verrou de prix. La
 * passerelle POSSÉDAIT donc le domaine des prix, avec ses huit modèles Mongoose
 * et sa base de données.
 *
 * ── Pourquoi c'était un défaut, et pas une préférence ───────────────────────
 *
 * Tx-Core — le moteur d'argent — venait chercher ses devis ICI, en HTTP :
 *
 *     Mobile ──► Gateway ──► Tx-Core ──► Gateway ──► base tarification
 *                                          ▲
 *                                  dépendance qui REMONTE
 *
 * Tx-Core l'annonçait lui-même au démarrage : « GATEWAY_URL absente ⇒ toute
 * transaction nécessitant un devis échouera en 503 ». Une panne de la
 * passerelle n'empêchait donc pas seulement les clients d'entrer : **elle
 * arrêtait les virements depuis l'intérieur du moteur**, et la passerelle ne
 * pouvait plus être redéployée ni redémarrée seule.
 *
 * Et la base des barèmes vivait sur la surface la plus exposée d'Internet.
 *
 * ── La règle appliquée, celle de Stripe, PayPal et Adyen ────────────────────
 *
 * LES DÉPENDANCES DESCENDENT : bord → services → moteur, jamais l'inverse.
 *
 * Le bord fait cinq choses et pas une de plus : terminaison TLS et routage,
 * vérification du jeton, limitation de débit, validation de forme et
 * corrélation, observabilité. Il ne décide d'aucun prix, n'évalue aucun risque
 * métier, ne possède aucun domaine et ne détient aucune base.
 *
 * Le moteur de devis vit désormais dans `api-paynoval/src/services/pricing/`.
 * Tx-Core l'appelle en PROCESSUS ; la passerelle, elle, le relaie pour le monde
 * extérieur. Ce fichier n'est plus qu'un relais.
 *
 * ── Ce qu'un relais ne doit pas faire ───────────────────────────────────────
 *
 * Réinterpréter la réponse. Un 404 « aucun barème ne couvre ce corridor » et un
 * 503 « taux de change indisponible » sont des informations que l'appelant doit
 * recevoir telles quelles. Les fondre en un 502 générique, ou pire en un 200
 * avec un prix par défaut, ferait accepter un virement à un tarif que personne
 * n'a décidé (règle B.2).
 */

const axios = require("axios");
const crypto = require("crypto");
const logger = require("../src/logger");

const TIMEOUT_MS = Number(process.env.PRICING_PROXY_TIMEOUT_MS || 12000);

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

function identifiantRequete(req) {
  return (
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    crypto.randomUUID()
  );
}

/**
 * Le corps du devis. La passerelle ne le NORMALISE pas : c'est le service de
 * tarification qui décide ce qu'est un corridor valide, et deux normalisations
 * pour une même donnée divergent toujours — celle du bord gagnerait en silence.
 */
function chargeUtile(req) {
  return req.body && Object.keys(req.body).length ? req.body : req.query || {};
}

function erreur(res, status, message, code) {
  return res.status(status).json({
    success: false,
    ok: false,
    code,
    error: message,
    message,
  });
}

async function relayer(req, res, chemin, { userId = "" } = {}) {
  const base = baseTxCore();
  const jeton = jetonInterne();

  if (!base || !jeton) {
    /**
     * Règle B.2 : le chemin de l'argent échoue en FERMETURE. Sans cible ni
     * jeton, on ne sert pas un prix approximatif — on refuse et on le dit.
     */
    logger.error("[pricing] Tx-Core non configuré", {
      urlPresente: Boolean(base),
      jetonPresent: Boolean(jeton),
    });

    return erreur(
      res,
      503,
      "Service de tarification indisponible.",
      "PRICING_UNCONFIGURED"
    );
  }

  const reqId = identifiantRequete(req);

  try {
    const reponse = await axios.post(`${base}${chemin}`, chargeUtile(req), {
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-internal-token": jeton,
        "x-request-id": reqId,
        ...(userId ? { "x-user-id": String(userId) } : {}),
      },
    });

    /**
     * ⚠️ Statut et corps relayés VERBATIM. Voir l'en-tête : un 404 corridor et
     * un 503 change indisponible portent chacun une information que l'appelant
     * doit pouvoir distinguer.
     */
    return res.status(reponse.status).json(reponse.data);
  } catch (err) {
    const timeout =
      err.code === "ECONNABORTED" ||
      String(err.message || "").toLowerCase().includes("timeout");

    logger.error("[pricing] Tx-Core injoignable", {
      chemin,
      timeout,
      message: err?.message,
      reqId,
    });

    return erreur(
      res,
      timeout ? 504 : 502,
      "Tarification momentanément indisponible.",
      timeout ? "PRICING_TIMEOUT" : "PRICING_UNAVAILABLE"
    );
  }
}

/** `GET|POST /api/v1/pricing/quote` et son alias public. Lecture seule. */
exports.quote = async (req, res) => relayer(req, res, "/api/v1/pricing/quote");

/**
 * `POST /api/v1/pricing/lock`. Un verrou engage PayNoval envers QUELQU'UN.
 *
 * L'identité est établie ICI — c'est le travail du bord — puis relayée à
 * Tx-Core par `x-user-id` sur le canal interne. Tx-Core ne revérifie pas de
 * session : il fait confiance au canal, ce qui n'est légitime que parce que le
 * jeton interne l'authentifie.
 */
exports.lock = async (req, res) => {
  const userId = req.user?._id || req.user?.id || "";

  if (!userId) {
    return erreur(res, 401, "Unauthorized", "UNAUTHORIZED");
  }

  return relayer(req, res, "/api/v1/pricing/lock", { userId });
};
