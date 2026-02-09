// src/tools/allowedFlows.js

/**
 * Table des flux autorisés
 * - funds : source à débiter
 * - destination : destination à créditer
 * - action : "send" | "deposit" | "withdraw"
 * - provider : provider technique à router (optionnel, utile pour debug/analytics)
 */

module.exports = [
  /* -----------------------------
   * SEND (wallet -> destination)
   * ----------------------------- */

  // Wallet PayNoval → Wallet PayNoval (P2P)
  { funds: "paynoval", destination: "paynoval", action: "send", provider: "paynoval" },

  // Wallet PayNoval → Mobile Money
  { funds: "paynoval", destination: "mobilemoney", action: "send", provider: "mobilemoney" },

  // Wallet PayNoval → Banque
  { funds: "paynoval", destination: "bank", action: "send", provider: "bank" },

  // Wallet PayNoval → Stripe (ex: payout card-like si tu le supportes)
  { funds: "paynoval", destination: "stripe", action: "send", provider: "stripe" },

  // Wallet PayNoval → Visa Direct
  { funds: "paynoval", destination: "visa_direct", action: "send", provider: "visa_direct" },

  /* -----------------------------
   * DEPOSIT (funds -> wallet)
   * ----------------------------- */

  // ✅ Carte → PayNoval
  { funds: "stripe", destination: "paynoval", action: "deposit", provider: "stripe" },

  // ✅ MobileMoney → PayNoval
  { funds: "mobilemoney", destination: "paynoval", action: "deposit", provider: "mobilemoney" },

  // ✅ Bank → PayNoval
  { funds: "bank", destination: "paynoval", action: "deposit", provider: "bank" },

  /* -----------------------------
   * WITHDRAW (wallet -> destination)
   * ----------------------------- */

  // ✅ PayNoval → bank
  { funds: "paynoval", destination: "bank", action: "withdraw", provider: "bank" },

  // ✅ PayNoval → mobilemoney
  { funds: "paynoval", destination: "mobilemoney", action: "withdraw", provider: "mobilemoney" },

  // ✅ PayNoval → carte/visa_direct
  { funds: "paynoval", destination: "visa_direct", action: "withdraw", provider: "visa_direct" },

  /* -----------------------------
   * EXTRA (si tu actives plus tard)
   * ----------------------------- */

  // Exemple : Stripe → MobileMoney (bridge)
  { funds: "stripe2momo", destination: "mobilemoney", action: "send", provider: "stripe2momo" },

  // Flutterwave (si tu actives un corridor)
  { funds: "flutterwave", destination: "paynoval", action: "deposit", provider: "flutterwave" },
  { funds: "paynoval", destination: "flutterwave", action: "withdraw", provider: "flutterwave" },
];
