// src/tools/allowedFlows.js

/**
 * Table des flux autorisés : chaque objet = une combinaison possible funds/destination/action
 * - funds : source à débiter
 * - destination : compte à créditer
 * - action : "send", "deposit", "withdraw", etc. (optionnel si tu veux filtrer par action)
 * - provider : provider technique à router dans le backend (ex : "mobilemoney", "bank"…)
 */

module.exports = [
  // Wallet PayNoval → Mobile Money (envoi)
  { funds: 'paynoval', destination: 'mobilemoney', action: 'send', provider: 'mobilemoney' },

  // Wallet PayNoval → Banque
  { funds: 'paynoval', destination: 'bank', action: 'send', provider: 'bank' },

  // Wallet PayNoval → Wallet PayNoval (P2P)
  { funds: 'paynoval', destination: 'paynoval', action: 'send', provider: 'paynoval' },

  // Carte (stripe) → Wallet PayNoval (dépôt)
  { funds: 'stripe', destination: 'paynoval', action: 'deposit', provider: 'stripe' },

  // Mobile Money → Wallet PayNoval (dépôt)
  { funds: 'mobilemoney', destination: 'paynoval', action: 'deposit', provider: 'mobilemoney' },

  // Wallet PayNoval → Carte (stripe) (retrait)
  { funds: 'paynoval', destination: 'stripe', action: 'withdraw', provider: 'stripe' },

  // Wallet PayNoval → Visa Direct
  { funds: 'paynoval', destination: 'visa_direct', action: 'withdraw', provider: 'visa_direct' },

  // Ajoute ici tous les cas d’usage autorisés dans TON business
];
