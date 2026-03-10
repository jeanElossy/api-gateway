"use strict";

/**
 * --------------------------------------------------------------------------
 * Gateway Provider Webhooks Controller
 * --------------------------------------------------------------------------
 * Rôle :
 * - forwarder technique des webhooks externes vers le microservice cible
 *
 * IMPORTANT :
 * - la validation cryptographique des signatures doit idéalement être faite
 *   dans le service provider final ou ici si tu centralises les secrets.
 * - ce controller ne doit pas dépendre d'un JWT user.
 * --------------------------------------------------------------------------
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

const logger = reqAny([
  "../src/logger",
  "../logger",
  "../src/utils/logger",
  "../utils/logger",
]);

const { safeAxiosRequest } = require("../services/transactions/httpClient");
const { getTargetService } = require("../services/transactions/providerRegistry");

function buildForwardHeaders(req, providerName) {
  return {
    "content-type": req.headers["content-type"] || "application/json",
    "user-agent":
      req.headers["user-agent"] || "PayNoval-Webhook-Forwarder/1.0",
    "x-webhook-provider": providerName,
    "x-forwarded-for": req.headers["x-forwarded-for"] || "",
    "x-request-id": req.headers["x-request-id"] || "",
    "x-internal-token":
      process.env.GATEWAY_INTERNAL_TOKEN ||
      process.env.INTERNAL_TOKEN ||
      "",
    ...(req.headers["stripe-signature"]
      ? { "stripe-signature": req.headers["stripe-signature"] }
      : {}),
    ...(req.headers["x-signature"] ? { "x-signature": req.headers["x-signature"] } : {}),
    ...(req.headers["x-paynoval-signature"]
      ? { "x-paynoval-signature": req.headers["x-paynoval-signature"] }
      : {}),
  };
}

function getWebhookEndpoint(providerName) {
  switch (providerName) {
    case "visa_direct":
      return "/webhooks/visa-direct";
    default:
      return `/webhooks/${providerName}`;
  }
}

async function forwardWebhookToProvider(req, res, providerName) {
  const serviceUrl = getTargetService(providerName);

  if (!serviceUrl) {
    return res.status(400).json({
      success: false,
      error: `Webhook provider inconnu: ${providerName}`,
    });
  }

  const url = `${String(serviceUrl).replace(/\/+$/, "")}${getWebhookEndpoint(
    providerName
  )}`;

  try {
    const response = await safeAxiosRequest({
      method: "post",
      url,
      data: req.body,
      headers: buildForwardHeaders(req, providerName),
      timeout: 20000,
    });

    return res.status(response.status || 200).json(
      response.data || {
        success: true,
        forwarded: true,
        provider: providerName,
      }
    );
  } catch (err) {
    logger.error?.("[Gateway][Webhook] forward failed", {
      provider: providerName,
      status: err?.response?.status,
      error: err?.response?.data || err?.message,
    });

    return res.status(err?.response?.status || err?.status || 502).json({
      success: false,
      error:
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Erreur forwarding webhook",
      provider: providerName,
    });
  }
}

exports.mobilemoneyWebhook = async (req, res) =>
  forwardWebhookToProvider(req, res, "mobilemoney");

exports.bankWebhook = async (req, res) =>
  forwardWebhookToProvider(req, res, "bank");

exports.stripeWebhook = async (req, res) =>
  forwardWebhookToProvider(req, res, "stripe");

exports.visaDirectWebhook = async (req, res) =>
  forwardWebhookToProvider(req, res, "visa_direct");