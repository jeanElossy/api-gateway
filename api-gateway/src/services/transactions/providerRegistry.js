"use strict";

/**
 * Registry providers -> microservices
 * + helpers de normalisation provider/rail
 */

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

const MOBILEMONEY_PROVIDERS = new Set([
  "wave",
  "orange",
  "mtn",
  "moov",
  "flutterwave",
]);

const PROVIDER_TO_SERVICE = {
  paynoval: process.env.PAYNOVAL_SERVICE_URL || config.microservices?.paynoval,
  stripe: config.microservices?.stripe,
  bank: config.microservices?.bank,
  mobilemoney: config.microservices?.mobilemoney,
  visa_direct: config.microservices?.visa_direct,
  visadirect: config.microservices?.visa_direct,
  cashin: config.microservices?.cashin,
  cashout: config.microservices?.cashout,
  stripe2momo: config.microservices?.stripe2momo,
  flutterwave: config.microservices?.flutterwave,
};

function low(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeProviderForRouting(provider) {
  const s = low(provider);
  if (!s) return "";
  if (MOBILEMONEY_PROVIDERS.has(s)) return "mobilemoney";
  if (s === "visadirect") return "visa_direct";
  if (s === "card") return "visa_direct";
  return s;
}

function normalizeRail(v) {
  const s = low(v);
  if (MOBILEMONEY_PROVIDERS.has(s)) return "mobilemoney";
  if (["visa_direct", "visadirect", "stripe"].includes(s)) return "card";
  return s;
}

function computeProviderSelected(action, funds, destination) {
  const a = low(action);
  const f = low(funds);
  const d = low(destination);

  if (a === "deposit") return f;
  if (a === "withdraw") return d;
  return d;
}

function resolveProvider(req, fallback = "paynoval") {
  const body = req.body || {};
  const query = req.query || {};

  const routed = req.routedProvider || req.providerSelected;
  if (routed) return low(routed);

  if (body.providerSelected) return low(body.providerSelected);
  if (body.provider) return low(body.provider);
  if (body.metadata?.provider) return low(body.metadata.provider);

  if (body.destination) return low(body.destination);
  if (query.provider) return low(query.provider);

  return low(fallback);
}

function ensureMetaProvider(req) {
  const b = req.body || {};
  b.metadata =
    typeof b.metadata === "object" && b.metadata && !Array.isArray(b.metadata)
      ? b.metadata
      : {};
  req.body = b;
  return b;
}

function normalizeMobileMoneyProviderInBody(req) {
  const b = ensureMetaProvider(req);

  const p = low(
    b.metadata?.provider ||
      b.provider ||
      b.providerSelected ||
      b.mmProvider ||
      b.operator ||
      ""
  );

  const funds = low(b.funds);
  const dest = low(b.destination);

  const pFromFunds = MOBILEMONEY_PROVIDERS.has(funds) ? funds : "";
  const pFromDest = MOBILEMONEY_PROVIDERS.has(dest) ? dest : "";

  const finalProvider = p || pFromFunds || pFromDest;

  if (finalProvider && MOBILEMONEY_PROVIDERS.has(finalProvider)) {
    b.metadata.provider = finalProvider;
    b.provider = finalProvider;

    if (MOBILEMONEY_PROVIDERS.has(funds)) b.funds = "mobilemoney";
    if (MOBILEMONEY_PROVIDERS.has(dest)) b.destination = "mobilemoney";
  }

  req.body = b;
  return b;
}

function resolveProviderForRequest(req, fallbackProvider = "paynoval") {
  return normalizeProviderForRouting(resolveProvider(req, fallbackProvider));
}

function getTargetService(provider) {
  return PROVIDER_TO_SERVICE[normalizeProviderForRouting(provider)] || null;
}

module.exports = {
  PROVIDER_TO_SERVICE,
  MOBILEMONEY_PROVIDERS,
  normalizeProviderForRouting,
  normalizeRail,
  computeProviderSelected,
  resolveProvider,
  ensureMetaProvider,
  normalizeMobileMoneyProviderInBody,
  resolveProviderForRequest,
  getTargetService,
};