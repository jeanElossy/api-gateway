"use strict";

/**
 * ============================================================================
 * CLIENT TX CORE — LE BORD N'A PLUS QU'UNE SEULE DESTINATION
 * ============================================================================
 *
 * ── Ce que cette couche remplace ────────────────────────────────────────────
 *
 * Le bord portait 3 354 lignes d'orchestration : résolution du flux, sélection
 * du prestataire, table `provider → microservice`, trois adaptateurs, un
 * routeur d'actions d'administration. Quatre constats l'ont rendue caduque :
 *
 *   1. **Tx-Core résout déjà les flux.** `flowHelpers.resolveExternalFlow` fait
 *      exactement ce que `flowResolver.js` faisait ici — deux implémentations
 *      de la même décision, qui avaient déjà divergé (le bord refusait les flux
 *      bancaires, le moteur les laissait tomber sur `undefined`) ;
 *   2. **Tx-Core possède les vrais adaptateurs** — 1 963 lignes, cinq
 *      prestataires, branchés par `providerSelector` ;
 *   3. **Les adaptateurs du bord ne pointaient nulle part.** `providerRegistry`
 *      mappait `mobilemoney` et `visa_direct` vers `SERVICE_MOBILEMONEY_URL` et
 *      `SERVICE_VISA_DIRECT_URL`, que la configuration laisse vides. Le code
 *      faisait alors `throw 400 "Aucun service configuré"` : ces deux rails
 *      étaient FERMÉS au bord, avant même d'atteindre le moteur ;
 *   4. **Seul `paynoval` résolvait** — et il pointe sur Tx-Core.
 *
 * Autrement dit, la couche de dispatch aiguillait vers des services qui
 * n'existent pas, et la seule branche vivante menait déjà ici.
 *
 * ── Pourquoi c'est SÛR quelle que soit la configuration ────────────────────
 *
 * Router tout vers Tx-Core rouvre les rails mobile money et carte. Ce n'est pas
 * un risque : `api-paynoval/src/providers/providerMode.js` LÈVE en production
 * sur un rail non configuré — « un rail non configuré ne doit pas accepter
 * d'ordre de paiement » — et simule hors production. Aucun euro ne bouge par
 * un chemin que personne n'a configuré.
 *
 * La chaîne de `/initiate` de Tx-Core reste entière : jeton, idempotence,
 * validation, éligibilité, rail autorisé, AML, confiance du numéro de dépôt.
 *
 * ── Ce que le bord GARDE, et pourquoi ──────────────────────────────────────
 *
 *   · `normalizers.js` — la couche anti-corruption. Le mobile envoie une charge
 *     souple, Tx-Core en veut une stricte ; et la réponse fait le chemin
 *     inverse. C'est de la TRADUCTION, pas de la décision : elle appartient au
 *     bord, exactement comme Stripe traduit pour ses anciennes versions d'API ;
 *   · `httpClient.safeAxiosRequest` — le disjoncteur à trois états ;
 *   · `phoneSecurity.auditForwardHeaders` — la clé d'idempotence et la
 *     corrélation.
 *
 * ⚠️ NE PAS RÉINTRODUIRE ICI DE RÉSOLUTION DE FLUX NI DE CHOIX DE PRESTATAIRE.
 * `test/transactions/edgeHasNoRouting.test.js` échoue si l'une revient.
 */

const { safeAxiosRequest } = require("./httpClient");
const { auditForwardHeaders } = require("./phoneSecurity");

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

/**
 * `SERVICE_PAYNOVAL_URL` porte déjà le préfixe `/api/v1` : les chemins passés
 * ici sont donc relatifs à celui-ci (`/transactions/initiate`, etc.).
 *
 * C'est la SEULE variable de service encore obligatoire au démarrage, et elle
 * désigne Tx-Core. Les cinq autres (`SERVICE_MOBILEMONEY_URL`,
 * `SERVICE_VISA_DIRECT_URL`, …) ont été retirées avec la couche de dispatch.
 */
function baseTxCore() {
  const brut =
    process.env.PAYNOVAL_SERVICE_URL || config.microservices?.paynoval || "";

  return String(brut).replace(/\/+$/, "");
}

function erreurTxCore(err, message = "Erreur Tx-Core") {
  const e = new Error(
    err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      message
  );

  e.status = err?.response?.status || err?.status || 502;
  e.response = err?.response;
  e.isProviderCooldown = !!err?.isProviderCooldown;
  e.isCloudflareChallenge = !!err?.isCloudflareChallenge;
  e.cooldown = err?.cooldown || null;

  return e;
}

/**
 * Appelle Tx-Core. Rend `{ status, body }` — jamais un corps nu, pour que
 * l'appelant puisse relayer le statut VERBATIM.
 *
 * ⚠️ ÉCHEC EN FERMETURE SI LA CIBLE MANQUE. Rendre une liste vide ou un succès
 * approximatif ferait passer une panne de configuration pour un état métier ;
 * c'est exactement le défaut qui, le 2026-08-19, a fait écraser l'historique
 * local du mobile par une liste vide.
 */
async function appelerTxCore({
  req,
  method = "get",
  chemin,
  body = undefined,
  params = undefined,
  timeout = 15000,
}) {
  const base = baseTxCore();

  if (!base) {
    const e = new Error(
      "Tx-Core n'est pas configuré (SERVICE_PAYNOVAL_URL absente)."
    );
    e.status = 503;
    e.code = "TX_CORE_UNCONFIGURED";
    throw e;
  }

  const url = `${base}${chemin}`;

  try {
    const reponse = await safeAxiosRequest({
      method,
      url,
      data: body,
      params,
      headers: auditForwardHeaders(req),
      timeout,
    });

    return { status: reponse.status, body: reponse.data || {}, url };
  } catch (err) {
    throw erreurTxCore(err);
  }
}

module.exports = { baseTxCore, appelerTxCore, erreurTxCore };
