"use strict";

/**
 * Adapter PayNoval
 * - utilisé pour le flow interne
 * - peut aussi servir de lecture canonique TX Core
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

function buildProviderError(err, fallbackMessage = "Erreur provider paynoval") {
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

async function postToPaynovalService({
  req,
  serviceUrl,
  endpoint,
  body,
  timeout = 15000,
}) {
  const url = `${cleanBaseUrl(serviceUrl)}${endpoint}`;
  const userId = getUserId(req);

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url,
      data: body,
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
    throw buildProviderError(err, "Erreur provider paynoval");
  }
}

module.exports = {
  postToPaynovalService,
};