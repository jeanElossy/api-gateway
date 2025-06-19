// File: tools/amlLimits.js

/**
 * Plafonds AML _journaliers_ (cumul 24h)
 * Par provider et devise.
 */
const AML_DAILY_LIMITS = {
  paynoval: {
    "F CFA": 5_000_000,
    "€": 10_000,
    "$": 10_000,
    "$USD": 10_000,
    "$CAD": 10_000,
    "₦": 2_500_000,
    "₵": 50_000,
    "₹": 700_000,
    "¥": 80_000,
    "£": 8_000,
    "R$": 40_000,
    "R": 200_000,
    // ...ajoute ici si besoin
  },
  stripe: {
    "F CFA": 3_000_000,
    "€": 10_000,
    "$": 10_000,
    "$USD": 10_000,
    "$CAD": 10_000,
  },
  mobilemoney: {
    "F CFA": 2_000_000,
    "€": 2_000,
    "$": 2_000,
    "$USD": 2_000,
    "$CAD": 2_000,
  },
  bank: {
    "F CFA": 50_000_000,
    "€": 100_000,
    "$": 100_000,
    "$USD": 100_000,
    "$CAD": 100_000,
  }
};

/**
 * Plafonds AML _par envoi_ (single transaction)
 * (Tu peux adapter selon politique risque / business, cf. exemples ci-dessous)
 */
const AML_SINGLE_TX_LIMITS = {
  paynoval: {
    "F CFA": 2_000_000,
    "€": 4_000,
    "$": 4_000,
    "$USD": 4_000,
    "$CAD": 4_000,
    "₦": 1_000_000,
    "₵": 20_000,
    "₹": 300_000,
    "¥": 30_000,
    "£": 3_000,
    "R$": 10_000,
    "R": 80_000,
    // ...ajuste ici selon ta politique
  },
  stripe: {
    "F CFA": 1_500_000,
    "€": 2_000,
    "$": 2_000,
    "$USD": 2_000,
    "$CAD": 2_000,
  },
  mobilemoney: {
    "F CFA": 750_000,
    "€": 1_000,
    "$": 1_000,
    "$USD": 1_000,
    "$CAD": 1_000,
  },
  bank: {
    "F CFA": 10_000_000,
    "€": 40_000,
    "$": 40_000,
    "$USD": 40_000,
    "$CAD": 40_000,
  }
};

/**
 * Helpers universels
 */
function getSingleTxLimit(provider, currency) {
  const limits = AML_SINGLE_TX_LIMITS[provider] || {};
  return limits[currency] || limits["$"] || 1_000_000;
}
function getDailyLimit(provider, currency) {
  const limits = AML_DAILY_LIMITS[provider] || {};
  return limits[currency] || limits["$"] || 5_000_000;
}

module.exports = {
  AML_SINGLE_TX_LIMITS,
  AML_DAILY_LIMITS,
  getSingleTxLimit,
  getDailyLimit,
};
