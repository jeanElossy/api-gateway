"use strict";

/**
 * Adapter Mobile Money
 * - normalise provider dans metadata.provider
 * - supporte wave/orange/mtn/moov/flutterwave
 * - réponse homogène vers l'app
 */

const { safeAxiosRequest } = require("../httpClient");
const { normalizeTxForResponse } = require("../normalizers");
const { auditForwardHeaders, getUserId } = require("../phoneSecurity");

const MOBILEMONEY_PROVIDER_SET = new Set([
  "wave",
  "orange",
  "mtn",
  "moov",
  "flutterwave",
]);

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function extractPayloadData(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.data || payload.transaction || payload;
}

function normalizeMmProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (MOBILEMONEY_PROVIDER_SET.has(p)) return p;
  return "";
}

function enrichMobileMoneyMetadata(body = {}) {
  const out = { ...(body || {}) };
  out.metadata =
    typeof out.metadata === "object" && out.metadata && !Array.isArray(out.metadata)
      ? { ...out.metadata }
      : {};

  const rawProvider =
    out.metadata?.provider ||
    out.provider ||
    out.providerSelected ||
    out.mmProvider ||
    out.operator ||
    "";

  const mmProvider = normalizeMmProvider(rawProvider);

  if (mmProvider) {
    out.metadata.provider = mmProvider;
    out.provider = mmProvider;
  }

  return out;
}

function buildProviderError(err, fallbackMessage = "Erreur provider mobilemoney") {
  const e = new Error(
    err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      fallbackMessage
  );

  e.status = err?.response?.status || err?.status || 502;
  e.response = err?.response;
  e.isProviderCooldown = !!err?.isProviderCooldown;
  e.isCloudflareChallenge = !!err?.isCloudflareChallenge;
  e.cooldown = err?.cooldown || null;

  return e;
}

async function postToMobileMoneyService({
  req,
  serviceUrl,
  endpoint,
  body,
  timeout = 15000,
}) {
  const finalBody = enrichMobileMoneyMetadata(body);
  const url = `${cleanBaseUrl(serviceUrl)}${endpoint}`;
  const userId = getUserId(req);

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url,
      data: finalBody,
      headers: auditForwardHeaders(req),
      timeout,
    });

    const payload = response.data || {};
    const data = extractPayloadData(payload);

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const normalized = normalizeTxForResponse(data, userId);

      if (payload?.data) payload.data = normalized;
      else if (payload?.transaction) payload.transaction = normalized;
      else return { status: response.status, body: normalized };
    }

    return { status: response.status, body: payload };
  } catch (err) {
    throw buildProviderError(err, "Erreur provider mobilemoney");
  }
}

module.exports = {
  MOBILEMONEY_PROVIDER_SET,
  normalizeMmProvider,
  enrichMobileMoneyMetadata,
  postToMobileMoneyService,
};