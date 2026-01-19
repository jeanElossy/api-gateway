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
  "cote d'ivoire": "XOF",
  "cote divoire": "XOF",
  "burkina faso": "XOF",
  mali: "XOF",
  senegal: "XOF",
  cameroun: "XAF",
  cameroon: "XAF",
  france: "EUR",
  belgique: "EUR",
  allemagne: "EUR",
  usa: "USD",
  "etats-unis": "USD",
  "etats unis": "USD",
  canada: "CAD",
  ghana: "GHS",
  nigeria: "NGN",
  inde: "INR",
  chine: "CNY",
  japon: "JPY",
  brazil: "BRL",
  bresil: "BRL",
  "afrique du sud": "ZAR",
  "royaume-uni": "GBP",
  "royaume uni": "GBP",
  uk: "GBP",
};

// --- Helpers ---
function normalizeCountry(country) {
  if (!country) return "";
  try {
    return String(country)
      .replace(/^[^\w]+/, "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  } catch {
    return String(country).toLowerCase().trim();
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
  const normalized = normalizeCountry(country);
  return COUNTRY_TO_CURRENCY[normalized] || "USD";
}

module.exports = {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
  CURRENCY_SYMBOLS,
  COUNTRY_TO_CURRENCY,
};
