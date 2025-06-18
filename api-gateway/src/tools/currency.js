// File: tools/currency.js

// Mapping code devise → symbole
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
  // Ajoute d'autres ici si besoin
};

// Country → Code devise (top pays, à compléter si tu veux)
const COUNTRY_TO_CURRENCY = {
  "cote d'ivoire": "XOF",
  "burkina faso": "XOF",
  "mali": "XOF",
  "senegal": "XOF",
  "cameroun": "XAF",
  "france": "EUR",
  "belgique": "EUR",
  "allemagne": "EUR",
  "usa": "USD",
  "etats-unis": "USD",
  "canada": "CAD",
  "ghana": "GHS",
  "nigeria": "NGN",
  "inde": "INR",
  "chine": "CNY",
  "japon": "JPY",
  "brazil": "BRL",
  "bresil": "BRL",
  "afrique du sud": "ZAR",
  "royaume-uni": "GBP",
  "uk": "GBP",
  // Ajoute ici autant que tu veux
};

// Donne le symbole à partir du code devise (fallback = code)
function getCurrencySymbolByCode(code) {
  if (!code) return "";
  return CURRENCY_SYMBOLS[code.toUpperCase()] || code.toUpperCase();
}

// Donne le code devise à partir du pays (fallback = USD)
function getCurrencyCodeByCountry(country) {
  if (!country) return "USD";
  const normalized = country
    .replace(/^[^\w]+/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return COUNTRY_TO_CURRENCY[normalized] || "USD";
}

module.exports = {
  getCurrencySymbolByCode,
  getCurrencyCodeByCountry,
  CURRENCY_SYMBOLS,
  COUNTRY_TO_CURRENCY,
};
