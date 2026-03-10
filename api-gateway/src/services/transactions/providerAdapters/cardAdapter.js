"use strict";

/**
 * Adapter Card
 * - gère stripe / visa_direct
 * - enrichit metadata.provider
 * - normalise la réponse
 */

const { safeAxiosRequest } = require("../httpClient");
const { normalizeTxForResponse } = require("../normalizers");
const { auditForwardHeaders, getUserId } = require("../phoneSecurity");

function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function extractPayloadData(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.data || payload.transaction || payload;
}

function normalizeCardProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "stripe") return "stripe";
  if (p === "visa_direct" || p === "visadirect") return "visa_direct";
  return "";
}

function enrichCardMetadata(body = {}) {
  const out = { ...(body || {}) };
  out.metadata =
    typeof out.metadata === "object" && out.metadata && !Array.isArray(out.metadata)
      ? { ...out.metadata }
      : {};

  const chosen =
    out.metadata?.provider ||
    out.provider ||
    out.providerSelected ||
    "";

  const normalized = normalizeCardProvider(chosen);
  if (normalized) {
    out.metadata.provider = normalized;
    out.provider = normalized;
  }

  return out;
}

function buildProviderError(err, fallbackMessage = "Erreur provider card") {
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

async function postToCardService({
  req,
  serviceUrl,
  endpoint,
  body,
  timeout = 20000,
}) {
  const finalBody = enrichCardMetadata(body);
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
    throw buildProviderError(err, "Erreur provider card");
  }
}

module.exports = {
  normalizeCardProvider,
  enrichCardMetadata,
  postToCardService,
};