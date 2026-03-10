"use strict";

/**
 * --------------------------------------------------------------------------
 * Gateway Transactions Controller
 * --------------------------------------------------------------------------
 * Contrôleur HTTP mince :
 * - délègue toute la logique au service orchestrator
 * - unifie le format d'erreur proxy/provider
 * - ajoute des logs détaillés pour faciliter le debug runtime
 * --------------------------------------------------------------------------
 */

const {
  getTransactionOrThrow,
  listTransactionsOrFallback,
  initiateTransactionOrThrow,
  forwardSimpleActionOrThrow,
  forwardAdminActionOrThrow,
  logInternalTransactionOrThrow,
} = require("../src/services/transactions/orchestrator");

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function buildErrorDetails(err) {
  return {
    message: err?.message,
    status: err?.status || err?.response?.status,
    payload: err?.payload,
    responseData: err?.response?.data,
    stack: err?.stack,
  };
}

function sendProxyError(res, err, fallbackMessage = "Erreur interne provider") {
  if (err?.payload && typeof err.payload === "object") {
    return res.status(err.status || 400).json(err.payload);
  }

  if (err?.isProviderCooldown || err?.isCloudflareChallenge) {
    const cd = err.cooldown || null;
    return res.status(503).json({
      success: false,
      message:
        "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
      error:
        "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
      details: err.isCloudflareChallenge
        ? "cloudflare_challenge"
        : "provider_cooldown",
      retryAfterSec: cd?.retryAfterSec,
    });
  }

  const status = err?.response?.status || err?.status || 502;

  let message =
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    (typeof err?.response?.data === "string" ? err.response.data : null) ||
    err?.message ||
    fallbackMessage;

  if (status === 429) {
    message =
      "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
  }

  const details = Array.isArray(err?.response?.data?.details)
    ? err.response.data.details
    : [];

  return res.status(status).json({
    success: false,
    message,
    error: message,
    details,
  });
}

exports.getTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][getTransaction] request", {
      params: req?.params,
      query: req?.query,
    });

    const out = await getTransactionOrThrow(req);

    console.log("[Gateway][Controller][getTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][getTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur lors du proxy GET transaction");
  }
};

exports.listTransactions = async (req, res) => {
  try {
    console.log("[Gateway][Controller][listTransactions] request", {
      query: req?.query,
    });

    const out = await listTransactionsOrFallback(req);

    console.log("[Gateway][Controller][listTransactions] success", {
      status: out?.status || 200,
      bodyPreview: {
        success: out?.body?.success,
        count: out?.body?.count,
        total: out?.body?.total,
        warning: out?.body?.warning,
      },
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][listTransactions] error", buildErrorDetails(err));

    return res.status(500).json({
      success: false,
      message: "Erreur interne (listTransactions).",
      error: "Erreur interne (listTransactions).",
      details: [],
    });
  }
};

exports.initiateTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][initiateTransaction] request.body", req?.body);
    console.log(
      "[Gateway][Controller][initiateTransaction] request.body.json",
      safeJson(req?.body)
    );

    const out = await initiateTransactionOrThrow(req);

    console.log("[Gateway][Controller][initiateTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][initiateTransaction] error", {
      ...buildErrorDetails(err),
      requestBody: req?.body,
    });

    return sendProxyError(res, err, "Erreur interne provider");
  }
};

exports.confirmTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][confirmTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardSimpleActionOrThrow(req, "confirm");

    console.log("[Gateway][Controller][confirmTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][confirmTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur interne provider (confirm)");
  }
};

exports.cancelTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][cancelTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardSimpleActionOrThrow(req, "cancel");

    console.log("[Gateway][Controller][cancelTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][cancelTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur interne provider (cancel)");
  }
};

exports.refundTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][refundTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardAdminActionOrThrow(req, "refund");

    console.log("[Gateway][Controller][refundTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][refundTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur proxy refund");
  }
};

exports.reassignTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][reassignTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardAdminActionOrThrow(req, "reassign");

    console.log("[Gateway][Controller][reassignTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][reassignTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur proxy reassign");
  }
};

exports.validateTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][validateTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardAdminActionOrThrow(req, "validate");

    console.log("[Gateway][Controller][validateTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][validateTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur proxy validate");
  }
};

exports.archiveTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][archiveTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardAdminActionOrThrow(req, "archive");

    console.log("[Gateway][Controller][archiveTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][archiveTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur proxy archive");
  }
};

exports.relaunchTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][relaunchTransaction] request", {
      body: req?.body,
      params: req?.params,
      query: req?.query,
    });

    const out = await forwardAdminActionOrThrow(req, "relaunch");

    console.log("[Gateway][Controller][relaunchTransaction] success", {
      status: out?.status || 200,
      body: out?.body,
    });

    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][relaunchTransaction] error", buildErrorDetails(err));
    return sendProxyError(res, err, "Erreur proxy relaunch");
  }
};

exports.logInternalTransaction = async (req, res) => {
  try {
    console.log("[Gateway][Controller][logInternalTransaction] request", {
      body: req?.body,
    });

    const out = await logInternalTransactionOrThrow(req);

    console.log("[Gateway][Controller][logInternalTransaction] success", {
      status: out?.status || 201,
      body: out?.body,
    });

    return res.status(out.status || 201).json(out.body);
  } catch (err) {
    console.error("[Gateway][Controller][logInternalTransaction] error", buildErrorDetails(err));

    const status = err?.status || 500;
    const message = err?.message || "Erreur lors de la création du log interne.";

    return res.status(status).json({
      success: false,
      message,
      error: message,
      details: [],
    });
  }
};