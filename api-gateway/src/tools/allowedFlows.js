// src/tools/allowedFlows.js
"use strict";

/**
 * LA TABLE DES FLUX AUTORISÉS — le point de fermeture du produit.
 *
 * Un couple {funds, destination, action} qui ne figure pas ici est refusé par
 * `validateTransaction`. C'est donc cette table, et non un écran mobile ni une
 * énumération de modèle, qui décide des transactions qui existent.
 *
 * ── Périmètre arrêté le 2026-09-08 ────────────────────────────────────────
 *
 * Trois rails, six flux :
 *
 *   paynoval    ⇄ paynoval      virement interne entre portefeuilles
 *   paynoval    ⇄ mobilemoney   dépôt et retrait mobile money
 *   paynoval    ⇄ visa_direct   dépôt et retrait par carte
 *
 * ── Ce qui a été RETIRÉ, et pourquoi ──────────────────────────────────────
 *
 *   stripe        décision produit du 2026-09-08. Les cartes passeront par un
 *                 partenaire qui sert Visa, Mastercard et les autres réseaux —
 *                 pas par Stripe.
 *   stripe2momo   pont bâti sur Stripe : sans objet une fois Stripe retiré.
 *   flutterwave   n'est pas un rail. C'est un opérateur, et un opérateur se
 *                 sert DERRIÈRE le rail `mobilemoney`, comme Orange ou MTN.
 *                 Lui donner ses propres flux créait un second chemin vers le
 *                 même argent, échappant aux plafonds du rail mobile money.
 *   bank          rail retiré le 2026-08-26. `providerSelector.js` lève dessus
 *                 depuis, mais les flux étaient restés là, en commentaires.
 *
 * ⚠️ LE DÉPÔT PAR CARTE A CHANGÉ DE RAIL. Il n'existait que sous la forme
 * `stripe → paynoval` : retirer Stripe sans rien faire d'autre aurait supprimé
 * la seule façon d'alimenter un portefeuille par carte, en silence. Le flux est
 * donc porté par `visa_direct → paynoval`, ce que le réseau sait faire (AFT,
 * l'opération de débit, symétrique de l'OCT utilisée pour le versement).
 *
 * ── Pourquoi `visa_direct` et non `card` ──────────────────────────────────
 *
 * `funds` et `destination` sont des valeurs de CONTRAT : l'application mobile
 * les envoie déjà telles quelles. Les renommer casserait les clients déployés.
 * La politique AML, elle, raisonne en FAMILLE de rail et normalise
 * `visa_direct`, `visa`, `mastercard` … vers `card` — de sorte que l'arrivée du
 * partenaire ne demandera aucune modification des plafonds. Voir
 * `tools/amlLimits.js`, table `RAIL_ALIASES`.
 */

module.exports = [
  /* ── SEND — portefeuille vers une destination ────────────────────────── */

  { funds: "paynoval", destination: "paynoval", action: "send", provider: "paynoval" },
  { funds: "paynoval", destination: "mobilemoney", action: "send", provider: "mobilemoney" },
  { funds: "paynoval", destination: "visa_direct", action: "send", provider: "visa_direct" },

  /* ── DEPOSIT — alimenter le portefeuille ─────────────────────────────── */

  { funds: "mobilemoney", destination: "paynoval", action: "deposit", provider: "mobilemoney" },
  { funds: "visa_direct", destination: "paynoval", action: "deposit", provider: "visa_direct" },

  /* ── WITHDRAW — sortir du portefeuille ───────────────────────────────── */

  { funds: "paynoval", destination: "mobilemoney", action: "withdraw", provider: "mobilemoney" },
  { funds: "paynoval", destination: "visa_direct", action: "withdraw", provider: "visa_direct" },
];
