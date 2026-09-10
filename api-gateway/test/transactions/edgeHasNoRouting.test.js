"use strict";

/**
 * ============================================================================
 * LE BORD NE RÉSOUT AUCUN FLUX ET NE CHOISIT AUCUN PRESTATAIRE
 * ============================================================================
 *
 * ── Ce que ce test remplace ─────────────────────────────────────────────────
 *
 * `noBankFlow.test.js` vérifiait que `flowResolver.js` ne produisait plus de
 * flux bancaire. Ce fichier n'existe plus : la résolution de flux du bord était
 * une DUPLICATION de celle de Tx-Core (`flowHelpers.resolveExternalFlow`), et
 * les deux avaient déjà divergé — le bord refusait le bancaire, le moteur le
 * laissait tomber sur `undefined`.
 *
 * L'invariant bancaire a donc migré là où il mord : `api-paynoval/test/noBankRail.test.js`.
 * Celui qui reste ici est plus large, et c'est le bon : **le bord ne décide de
 * rien.**
 *
 * ── Pourquoi c'est l'invariant qui compte ──────────────────────────────────
 *
 * Chez Stripe, la couche d'API authentifie, valide, applique l'idempotence et
 * passe la main : elle ne choisit ni le flux ni l'acquéreur. Chez Adyen et
 * Checkout.com, un endpoint unique et un moteur de routage décident. La
 * passerelle ne route jamais par rail.
 *
 * Dupliquer ce choix au bord garantit qu'il divergera — c'est précisément ce
 * qui s'était produit, et ce que ce test empêche de recommencer.
 *
 * ── Ce qui reste légitimement au bord ──────────────────────────────────────
 *
 * `normalizers.js` (traduction souple ↔ stricte), `httpClient.js` (disjoncteur),
 * `phoneSecurity.js` (en-têtes d'idempotence et corrélation), `listCache.js`.
 * De la traduction et de la plomberie — jamais une décision.
 *
 * Test **pur** : il lit des fichiers, n'ouvre aucune connexion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RACINE = path.resolve(__dirname, "..", "..");
const COUCHE = path.join(RACINE, "src", "services", "transactions");

function sansCommentaires(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FICHIERS = fs.readdirSync(COUCHE).filter((f) => f.endsWith(".js"));

const SOURCE = FICHIERS.map((f) =>
  sansCommentaires(fs.readFileSync(path.join(COUCHE, f), "utf8"))
).join("\n");

test("la couche de dispatch par rail n'est pas revenue", () => {
  /**
   * Huit fichiers formaient cette couche : résolution de flux, registre
   * `provider → microservice`, orchestrateur, routeur d'actions admin et trois
   * adaptateurs. Deux des trois adaptateurs visaient des URL vides — les rails
   * mobile money et carte étaient FERMÉS au bord, en 400, avant d'atteindre le
   * moteur qui, lui, possède les vrais adaptateurs.
   */
  const morts = [
    "flowResolver.js",
    "providerRegistry.js",
    "transactionOrchestratorByFlow.js",
    "adminFlowRouter.js",
    "transactionFlow.constants.js",
    "providerAdapters",
  ];

  for (const nom of morts) {
    assert.ok(
      !fs.existsSync(path.join(COUCHE, nom)),
      `\`${nom}\` est de retour. Le bord ne route pas par rail : Tx-Core résout ` +
        "le flux, choisit le prestataire et possède les cinq adaptateurs réels."
    );
  }
});

test("aucun module du bord ne résout un flux", () => {
  for (const motif of [
    /resolveTransactionFlow\s*\(/,
    /resolveExternalFlow\s*\(/,
    /TRANSACTION_FLOWS\b/,
    /getDefaultProviderForFlow\s*\(/,
  ]) {
    assert.ok(
      !motif.test(SOURCE),
      `Une résolution de flux (${motif}) est revenue au bord. C'est la décision ` +
        "de Tx-Core, et l'avoir en double les a déjà fait diverger."
    );
  }
});

test("aucun module du bord ne choisit un prestataire ni son service", () => {
  for (const motif of [
    /getTargetService\s*\(/,
    /PROVIDER_TO_SERVICE\b/,
    /resolveProviderForRequest\s*\(/,
    /computeProviderSelected\s*\(/,
  ]) {
    assert.ok(
      !motif.test(SOURCE),
      `Un choix de prestataire (${motif}) est revenu au bord. Chez Stripe et ` +
        "Adyen, c'est le moteur de routage qui choisit l'acquéreur — jamais la " +
        "passerelle."
    );
  }
});

test("une seule variable de service subsiste, et elle désigne Tx-Core", () => {
  const config = sansCommentaires(
    fs.readFileSync(path.join(RACINE, "src", "config", "index.js"), "utf8")
  );

  assert.match(
    config,
    /SERVICE_PAYNOVAL_URL/,
    "SERVICE_PAYNOVAL_URL a disparu : c'est l'adresse de Tx-Core."
  );

  /**
   * ⚠️ Une variable déclarée pour un rail qui n'existe pas laisse croire qu'il
   * suffirait de la renseigner pour l'activer. Les cinq autres pointaient vers
   * des microservices jamais déployés.
   */
  for (const morte of [
    "SERVICE_BANK_URL",
    "SERVICE_MOBILEMONEY_URL",
    "SERVICE_VISA_DIRECT_URL",
    "SERVICE_CASHIN_URL",
    "SERVICE_CASHOUT_URL",
    "SERVICE_FLUTTERWAVE_URL",
  ]) {
    assert.ok(
      !config.includes(morte),
      `\`${morte}\` est revenue. Le bord n'appelle plus qu'une destination.`
    );
  }
});

test("la traduction, elle, RESTE au bord", () => {
  /**
   * Le volet positif de la paire. Un test qui n'interdit que des choses pousse
   * à tout supprimer : celui-ci exige que la couche anti-corruption survive.
   * Le mobile envoie une charge souple, Tx-Core en veut une stricte — et la
   * réponse fait le chemin inverse. Stripe fait exactement ça pour ses
   * anciennes versions d'API.
   */
  for (const garde of ["normalizers.js", "httpClient.js", "phoneSecurity.js", "txCore.js"]) {
    assert.ok(
      fs.existsSync(path.join(COUCHE, garde)),
      `\`${garde}\` a disparu. C'est de la traduction ou de la plomberie, pas ` +
        "une décision : elle appartient au bord."
    );
  }

  assert.match(SOURCE, /normalizeTxForResponse\s*\(/);
  assert.match(SOURCE, /auditForwardHeaders\s*\(/);
});
