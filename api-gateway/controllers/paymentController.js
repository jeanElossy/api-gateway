"use strict";

/**
 * ============================================================================
 * `POST /api/v1/pay` — ENCAISSEMENT DEPUIS UN LIEN PUBLIC DE CAGNOTTE
 * ============================================================================
 *
 * Ce chemin sert UN cas : quelqu'un reçoit un lien de cagnotte, n'a pas de
 * compte PayNoval, et contribue par mobile money ou par carte.
 *
 * ── Ce que faisait ce fichier avant le 2026-09-10 ───────────────────────────
 *
 * Quatre défauts, dont trois sur le chemin de l'argent :
 *
 * 1. IL VISAIT UN CHEMIN FERMÉ. `PROVIDER_TO_ENDPOINT` postait sur
 *    `${SERVICE_PAYNOVAL_URL}/pay`, c'est-à-dire la route de Tx-Core RETIRÉE le
 *    2026-09-03 parce qu'elle déplaçait de l'argent hors du grand livre. Elle
 *    rend 410. La contribution par lien public ne pouvait donc PAS aboutir —
 *    quel que soit le rail.
 *
 * 2. IL CRÉDITAIT LA CAGNOTTE SUR UNE RÉPONSE HTTP.
 *    `notifyCagnotteExternalContribution` appelait le backend en
 *    « fire-and-forget » dès que le prestataire rendait 2xx, avec
 *    `status: "succeeded"` codé en dur. Or un 2xx d'un prestataire de
 *    collecte veut dire « j'ai accepté de prélever », pas « j'ai prélevé » :
 *    en mobile money, le client n'a même pas encore saisi son code. La cagnotte
 *    était donc créditée AVANT que l'argent existe (règle B.3), et le « fire-
 *    and-forget » garantissait que l'échec de ce crédit ne soit jamais vu de
 *    l'appelant.
 *
 * 3. IL FAISAIT DE LA TARIFICATION. `computeDynamicFees` appliquait 0,5 %
 *    codés en dur, en contournant le moteur de tarification de cette même
 *    passerelle. Deux barèmes pour un même produit divergent toujours ; celui
 *    qui est écrit en dur dans un contrôleur gagne, et personne ne sait
 *    pourquoi le devis affiché ne correspond pas au montant prélevé.
 *
 * 4. IL TRANSPORTAIT LE NUMÉRO DE CARTE EN CLAIR, avec un commentaire
 *    l'assumant explicitement (« on ne doit PAS nettoyer le body AVANT de
 *    forward… sinon on casse les providers (cardNumber/cvc…) »). Voir plus bas.
 *
 * ── Ce qu'il fait maintenant : une passerelle ───────────────────────────────
 *
 *   valider → refuser toute donnée de carte → traduire en {rail, prestataire}
 *   → relayer vers Tx-Core → rendre la réponse.
 *
 * Aucun calcul de frais, aucun effet de bord métier, aucune écriture. Le
 * mouvement d'argent appartient à Tx-Core, la cagnotte appartient au backend
 * principal, et la confirmation vient du rappel signé du prestataire.
 */

const axios = require("axios");
const crypto = require("crypto");
const logger = require("../src/logger");

/**
 * ============================================================================
 * ⚠️ LE NUMÉRO DE CARTE N'ENTRE PAS
 * ============================================================================
 *
 * La page de contribution publique postait `cardNumber`, `cvc`, `expMonth` et
 * `expYear` en clair vers cette passerelle, qui les relayait à Tx-Core, qui les
 * relayait au prestataire.
 *
 * Rien n'était stocké — ce n'est pas la question. Un PAN qui TRANSITE met le
 * serveur traversé dans le périmètre PCI-DSS : l'attestation applicable passe
 * de SAQ A à SAQ D, soit d'une trentaine de contrôles à plus de trois cents,
 * avec analyse de vulnérabilités trimestrielle et test d'intrusion annuel. Et
 * un PAN qui transite finit tôt ou tard dans un journal d'accès, une trace
 * d'erreur ou le corps d'une requête capturée par un intermédiaire réseau.
 *
 * Stripe, Adyen et Checkout.com font tous la même chose : le navigateur du
 * payeur envoie la carte DIRECTEMENT au prestataire, qui rend un jeton opaque.
 * Le serveur du marchand ne voit qu'un jeton. C'est la voie retenue.
 *
 * Le refus est explicite et bruyant. L'ignorer silencieusement laisserait la
 * page publique continuer d'émettre des PAN sans que personne ne l'apprenne —
 * c'est-à-dire le périmètre PCI ouvert, et invisible.
 */
/**
 * Une seule implémentation du refus, partagée avec le middleware qui l'applique
 * en amont. Deux copies du même contrôle divergent : celle qu'on oublie de
 * mettre à jour est celle qui laisse passer.
 */
const {
  CHAMPS_CARTE_INTERDITS,
  trouverChampCarte,
} = require("../src/middlewares/refuseRawCardData");

/**
 * Traduction du vocabulaire public vers le couple {rail, prestataire} de
 * Tx-Core. Table CLOSE, alignée sur `collectionService.RAILS` et sur
 * `cagnotteController.RAIL_PAR_OPERATEUR`.
 *
 * Le rail désigne le compte de compensation d'entrée
 * (`PROVIDER_INBOUND:<RAIL>`), donc le relevé prestataire auquel l'écriture
 * sera rapprochée. Rien ne s'y devine (règle B.2).
 */
const OPERATEURS_MOBILE_MONEY = Object.freeze(["wave", "orange", "mtn", "moov"]);

function resolverRail(corps = {}) {
  const declare = String(corps.provider || corps.destination || "")
    .trim()
    .toLowerCase();

  if (declare === "mobilemoney") {
    const operateur = String(corps.operator || "").trim().toLowerCase();

    if (!OPERATEURS_MOBILE_MONEY.includes(operateur)) {
      return { erreur: "UNKNOWN_PROVIDER" };
    }

    return { rail: "mobilemoney", provider: operateur };
  }

  if (declare === "visa_direct") {
    return { rail: "card", provider: "visa_direct" };
  }

  if (declare === "paynoval") {
    /**
     * Un titulaire de compte PayNoval qui participe à une cagnotte a un chemin
     * à lui, qui débite son portefeuille et écrit au grand livre :
     * `POST /api/v1/cagnottes/:id/participations/paynoval` sur le backend
     * principal. Le faire passer par ici créerait un SECOND chemin vers le même
     * argent — et deux implémentations d'un même mouvement divergent toujours.
     */
    return { erreur: "PAYNOVAL_RAIL_HAS_ITS_OWN_PATH" };
  }

  return { erreur: "UNKNOWN_RAIL" };
}

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
 * Clé d'idempotence : EXIGÉE, jamais inventée.
 *
 * Une clé tirée au hasard côté serveur serait différente à chaque requête —
 * autrement dit aucune idempotence du tout, présentée comme telle. Sur une page
 * de paiement publique, un double clic ou un bouton « réessayer » prélèverait
 * alors deux fois le payeur.
 *
 * C'est le client qui doit la fixer, une fois par tentative de paiement, comme
 * l'exigent Stripe (`Idempotency-Key`) et PayPal (`PayPal-Request-Id`).
 */
function cleIdempotence(req) {
  const entetes = req?.headers || {};

  for (const attendu of ["idempotency-key", "x-idempotency-key"]) {
    for (const nom of Object.keys(entetes)) {
      if (String(nom).toLowerCase() !== attendu) continue;
      const brut = entetes[nom];
      const valeur = Array.isArray(brut) ? brut[0] : brut;
      const propre = String(valeur ?? "").trim();
      if (propre) return propre;
    }
  }

  return "";
}

exports.handlePayment = async (req, res) => {
  const corps = req.body || {};
  const reqId = identifiantRequete(req);

  /* ── 1. AUCUNE DONNÉE DE CARTE — SECONDE BARRIÈRE ─────────────────────── */
  /**
   * Le refus est déjà porté par `refuseRawCardData`, monté AVANT
   * `validatePayment` (qui, lui, retirerait ces champs en silence). Ce second
   * contrôle ne sert donc jamais tant que la route est correctement montée —
   * et c'est précisément pourquoi il reste : un contrôleur atteint par un
   * montage futur qui aurait oublié le middleware ne doit pas s'ouvrir. Il
   * appelle la MÊME fonction, il ne peut pas diverger.
   */
  const champCarte = trouverChampCarte(corps);

  if (champCarte) {
    /**
     * ⚠️ On journalise le NOM du champ, jamais sa valeur. Journaliser
     * « cardNumber=4242… » pour expliquer qu'on refuse les numéros de carte
     * serait précisément la fuite qu'on ferme.
     */
    logger.error("[PAY] donnée de carte en clair refusée", {
      champ: champCarte,
      reqId,
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
    });

    return res.status(400).json({
      success: false,
      code: "RAW_CARD_DATA_REFUSED",
      error:
        "PayNoval n'accepte pas les données de carte en clair. La carte doit " +
        "être transmise au prestataire depuis le navigateur, qui rend un jeton.",
    });
  }

  /* ── 2. RAIL ET PRESTATAIRE ───────────────────────────────────────────── */
  const route = resolverRail(corps);

  if (route.erreur) {
    logger.warn("[PAY] rail non servi", {
      code: route.erreur,
      declare: String(corps.provider || corps.destination || ""),
      reqId,
    });

    const statut = route.erreur === "PAYNOVAL_RAIL_HAS_ITS_OWN_PATH" ? 410 : 400;

    return res.status(statut).json({
      success: false,
      code: route.erreur,
      error:
        route.erreur === "PAYNOVAL_RAIL_HAS_ITS_OWN_PATH"
          ? "Une participation depuis un compte PayNoval passe par " +
            "POST /api/v1/cagnottes/:id/participations/paynoval."
          : "Moyen de paiement non servi.",
    });
  }

  /* ── 3. IDEMPOTENCE ───────────────────────────────────────────────────── */
  const idem = cleIdempotence(req);

  if (idem.length < 8) {
    logger.warn("[PAY] clé d'idempotence absente", { reqId });

    return res.status(400).json({
      success: false,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      error:
        "En-tête Idempotency-Key requis : sans lui, un double envoi " +
        "prélèverait deux fois le payeur.",
    });
  }

  /* ── 4. CONFIGURATION ─────────────────────────────────────────────────── */
  const base = baseTxCore();
  const jeton = jetonInterne();

  if (!base || !jeton) {
    /**
     * Règle B.2 : le chemin de l'argent échoue en FERMETURE. Une URL ou un
     * jeton manquants ne se remplacent pas par un défaut — on refuse, et on le
     * dit, parce qu'un encaissement routé « quelque part » est pire qu'un
     * encaissement refusé.
     */
    logger.error("[PAY] Tx-Core non configuré", {
      urlPresente: Boolean(base),
      jetonPresent: Boolean(jeton),
      reqId,
    });

    return res.status(503).json({
      success: false,
      code: "COLLECTION_UNCONFIGURED",
      error: "Encaissement indisponible.",
    });
  }

  /* ── 5. RELAIS ────────────────────────────────────────────────────────── */
  const charge = {
    rail: route.rail,
    provider: route.provider,
    purpose: "cagnotte_participation",
    amount: Number(corps.amount),
    currency: String(corps.currency || corps.senderCurrencySymbol || "").toUpperCase(),
    target: {
      cagnotteId: String(corps.cagnotteId || ""),
      cagnotteCode: String(corps.cagnotteCode || ""),
    },
    payer: {
      phone: String(corps.phoneNumber || ""),
      displayName: String(corps.donorName || corps.recipientName || ""),
      country: String(corps.country || ""),
    },
    ...(corps.cardToken ? { cardToken: String(corps.cardToken) } : {}),
  };

  try {
    const reponse = await axios.post(
      `${base}/api/v1/collections/initiate`,
      charge,
      {
        timeout: 30_000,
        validateStatus: () => true,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-internal-token": jeton,
          "x-request-id": reqId,
          "Idempotency-Key": idem,
          "x-idempotency-key": idem,
        },
      }
    );

    /**
     * ⚠️ On relaie la réponse telle quelle, et on ne la réinterprète pas.
     *
     * `status: "pending"` veut dire « le prestataire prélève ». Le remplacer
     * par un message de succès ferait afficher un remerciement pour un
     * paiement qui peut encore échouer — c'est exactement ce que faisait
     * l'ancien code en déclenchant le crédit de la cagnotte sur un 2xx.
     */
    logger.info("[PAY] encaissement relayé", {
      rail: route.rail,
      provider: route.provider,
      status: reponse.status,
      collectionStatus: reponse.data?.collection?.status || null,
      reference: reponse.data?.collection?.reference || null,
      reqId,
    });

    return res.status(reponse.status).json(reponse.data);
  } catch (err) {
    const timeout =
      err.code === "ECONNABORTED" ||
      String(err.message || "").toLowerCase().includes("timeout");

    logger.error("[PAY] Tx-Core injoignable", {
      rail: route.rail,
      provider: route.provider,
      timeout,
      message: err?.message,
      reqId,
    });

    /**
     * ⚠️ 502/504 ET SURTOUT PAS 200. Le prélèvement a PEUT-ÊTRE été demandé —
     * l'intention est écrite avant l'appel prestataire côté Tx-Core. Le rejeu
     * de l'appelant, porteur de la même clé d'idempotence, retrouvera l'état
     * réel sans rien doubler.
     */
    return res.status(timeout ? 504 : 502).json({
      success: false,
      code: timeout ? "COLLECTION_TIMEOUT" : "COLLECTION_UNAVAILABLE",
      error: "Encaissement momentanément indisponible. Merci de réessayer.",
    });
  }
};

module.exports.CHAMPS_CARTE_INTERDITS = CHAMPS_CARTE_INTERDITS;
module.exports.OPERATEURS_MOBILE_MONEY = OPERATEURS_MOBILE_MONEY;
module.exports.trouverChampCarte = trouverChampCarte;
module.exports.resolverRail = resolverRail;
module.exports.cleIdempotence = cleIdempotence;
