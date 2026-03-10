"use strict";

/**
 * --------------------------------------------------------------------------
 * Gateway Transactions Controller
 * --------------------------------------------------------------------------
 * Contrôleur HTTP mince :
 * - délègue toute la logique au service orchestrator
 * - unifie le format d'erreur proxy/provider
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

function sendProxyError(res, err, fallbackMessage = "Erreur interne provider") {
  if (err?.payload && typeof err.payload === "object") {
    return res.status(err.status || 400).json(err.payload);
  }

  if (err?.isProviderCooldown || err?.isCloudflareChallenge) {
    const cd = err.cooldown || null;
    return res.status(503).json({
      success: false,
      error:
        "Service PayNoval temporairement indisponible (cooldown anti Cloudflare/429). Réessaye dans quelques instants.",
      details: err.isCloudflareChallenge
        ? "cloudflare_challenge"
        : "provider_cooldown",
      retryAfterSec: cd?.retryAfterSec,
    });
  }

  const status = err?.response?.status || err?.status || 502;
  let error =
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    (typeof err?.response?.data === "string" ? err.response.data : null) ||
    err?.message ||
    fallbackMessage;

  if (status === 429) {
    error =
      "Trop de requêtes vers le service de paiement PayNoval. Merci de patienter quelques instants avant de réessayer.";
  }

  return res.status(status).json({ success: false, error });
}

exports.getTransaction = async (req, res) => {
  try {
    const out = await getTransactionOrThrow(req);
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur lors du proxy GET transaction");
  }
};

exports.listTransactions = async (req, res) => {
  try {
    const out = await listTransactionsOrFallback(req);
    return res.status(out.status || 200).json(out.body);
  } catch (_err) {
    return res.status(500).json({
      success: false,
      error: "Erreur interne (listTransactions).",
    });
  }
};

exports.initiateTransaction = async (req, res) => {
  try {
    const out = await initiateTransactionOrThrow(req);
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur interne provider");
  }
};

exports.confirmTransaction = async (req, res) => {
  try {
    const out = await forwardSimpleActionOrThrow(req, "confirm");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur interne provider (confirm)");
  }
};

exports.cancelTransaction = async (req, res) => {
  try {
    const out = await forwardSimpleActionOrThrow(req, "cancel");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur interne provider (cancel)");
  }
};

exports.refundTransaction = async (req, res) => {
  try {
    const out = await forwardAdminActionOrThrow(req, "refund");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur proxy refund");
  }
};

exports.reassignTransaction = async (req, res) => {
  try {
    const out = await forwardAdminActionOrThrow(req, "reassign");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur proxy reassign");
  }
};

exports.validateTransaction = async (req, res) => {
  try {
    const out = await forwardAdminActionOrThrow(req, "validate");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur proxy validate");
  }
};

exports.archiveTransaction = async (req, res) => {
  try {
    const out = await forwardAdminActionOrThrow(req, "archive");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur proxy archive");
  }
};

exports.relaunchTransaction = async (req, res) => {
  try {
    const out = await forwardAdminActionOrThrow(req, "relaunch");
    return res.status(out.status || 200).json(out.body);
  } catch (err) {
    return sendProxyError(res, err, "Erreur proxy relaunch");
  }
};

exports.logInternalTransaction = async (req, res) => {
  try {
    const out = await logInternalTransactionOrThrow(req);
    return res.status(out.status || 201).json(out.body);
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({
      success: false,
      error: err?.message || "Erreur lors de la création du log interne.",
    });
  }
};