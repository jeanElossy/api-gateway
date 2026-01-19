// File: tools/currency.js
"use strict";

// Mapping code devise → symbole (clé = ISO)
const CURRENCY_SYMBOLS = {
  XOF: "F CFA",
  XAF: "F CFA",
  EUR: "€",
  USD: "$",
  CAD: "$CAD",
  GBP: "£",
  NGN: "₦",
  GHS: "₵",
  INR: "₹",
  CNY: "¥",
  JPY: "¥",
  BRL: "R$",
  ZAR: "R",
};

// Country → Code devise (à compléter)
const COUNTRY_TO_CURRENCY = {
  // Noms
  "cote d'ivoire": "XOF",
  "cote divoire": "XOF",
  "ivory coast": "XOF",
  "burkina faso": "XOF",
  mali: "XOF",
  senegal: "XOF",
  cameroun: "XAF",
  cameroon: "XAF",
  france: "EUR",
  belgique: "EUR",
  allemagne: "EUR",
  germany: "EUR",
  usa: "USD",
  "etats-unis": "USD",
  "etats unis": "USD",
  "united states": "USD",
  canada: "CAD",
  "royaume-uni": "GBP",
  "royaume uni": "GBP",
  uk: "GBP",
  "united kingdom": "GBP",

  // ISO2 (très important)
  ci: "XOF",
  bf: "XOF",
  ml: "XOF",
  sn: "XOF",
  cm: "XAF",
  fr: "EUR",
  be: "EUR",
  de: "EUR",
  us: "USD",
  ca: "CAD",
  gb: "GBP",

  // ISO2 uppercase (au cas où)
  CI: "XOF",
  BF: "XOF",
  ML: "XOF",
  SN: "XOF",
  CM: "XAF",
  FR: "EUR",
  BE: "EUR",
  DE: "EUR",
  US: "USD",
  CA: "CAD",
  GB: "GBP",
};

// --- Helpers ---
function normalizeCountry(country) {
  if (!country) return "";
  try {
    return String(country)
      .replace(/^[^\w]+/, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  } catch {
    return String(country).trim();
  }
}

// Donne le symbole à partir du code devise (fallback = code)
function getCurrencySymbolByCode(code) {
  if (!code) return "";
  const iso = String(code).trim().toUpperCase();
  return CURRENCY_SYMBOLS[iso] || iso;
}

// Donne le code devise à partir du pays (fallback = USD)
function getCurrencyCodeByCountry(country) {
  const raw = normalizeCountry(country);
  if (!raw) return "USD";

  // si déjà ISO2
  if (/^[A-Z]{2}$/.test(raw)) {
    return COUNTRY_TO_CURRENCY[raw] || COUNTRY_TO_CURRENCY[raw.toLowerCase()] || "USD";
  }

  const normalized = raw.toLowerCase();
  return COUNTRY_TO_CURRENCY[normalized] || "USD";
}

module.exports = {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
  CURRENCY_SYMBOLS,
  COUNTRY_TO_CURRENCY,
};
