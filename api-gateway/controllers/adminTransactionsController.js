"use strict";

const axios = require("axios");
const crypto = require("crypto");
const config = require("../src/config");
const logger = require("../src/logger");

function getTxCoreBaseUrl() {
  return (
    config?.microservices?.txcore ||
    process.env.TX_CORE_URL ||
    process.env.TRANSACTIONS_SERVICE_URL ||
    ""
  );
}

function buildAuditHeaders(req) {
  return {
    Authorization: req.headers.authorization || "",
    "x-internal-token": config.internalToken || "",
    "x-request-id": req.headers["x-request-id"] || crypto.randomUUID(),
    "x-user-id": String(req.user?._id || req.headers["x-user-id"] || ""),
    "x-user-role": String(req.user?.role || ""),
    "x-user-email": String(req.user?.email || ""),
    "x-session-id": req.headers["x-session-id"] || "",
  };
}

function buildAxiosConfig(req, extra = {}) {
  return {
    headers: buildAuditHeaders(req),
    timeout: extra.timeout || 20000,
    params: extra.params,
    responseType: extra.responseType,
    data: extra.data,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  };
}

async function forwardJson(res, upstreamPromise, logLabel, fallbackMessage) {
  try {
    const response = await upstreamPromise;

    if (response.status >= 200 && response.status < 300) {
      return res.status(response.status).json(response.data);
    }

    logger.error(`[Gateway][AdminTx] ${logLabel}:`, {
      status: response.status,
      error: response.data?.error || response.data?.message || fallbackMessage,
    });

    return res.status(response.status).json(
      response.data || {
        success: false,
        error: fallbackMessage,
      }
    );
  } catch (err) {
    const status = err.response?.status || 502;
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      fallbackMessage;

    logger.error(`[Gateway][AdminTx] ${logLabel}:`, { status, error });

    return res.status(status).json({
      success: false,
      error,
    });
  }
}

exports.listTransactions = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.get(
      `${txCoreBase}/api/v1/admin/transactions`,
      buildAxiosConfig(req, {
        params: req.query,
        timeout: 30000,
      })
    ),
    "LIST",
    "Erreur proxy LIST admin tx"
  );
};

exports.getTransactionById = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.get(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}`,
      buildAxiosConfig(req, { timeout: 15000 })
    ),
    "GET",
    "Erreur proxy GET admin tx"
  );
};

exports.validateTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/validate`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "VALIDATE",
    "Erreur proxy VALIDATE"
  );
};

exports.cancelTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/cancel`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "CANCEL",
    "Erreur proxy CANCEL"
  );
};

exports.refundTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/refund`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "REFUND",
    "Erreur proxy REFUND"
  );
};

exports.reassignTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/reassign`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "REASSIGN",
    "Erreur proxy REASSIGN"
  );
};

exports.relaunchTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/relaunch`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "RELAUNCH",
    "Erreur proxy RELAUNCH"
  );
};

exports.archiveTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.post(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}/archive`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "ARCHIVE",
    "Erreur proxy ARCHIVE"
  );
};

exports.updateTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.put(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}`,
      req.body,
      buildAxiosConfig(req, { timeout: 20000 })
    ),
    "UPDATE",
    "Erreur proxy UPDATE"
  );
};

exports.softDeleteTransaction = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  return forwardJson(
    res,
    axios.delete(
      `${txCoreBase}/api/v1/admin/transactions/${req.params.id}`,
      buildAxiosConfig(req, {
        timeout: 20000,
        data: req.body,
      })
    ),
    "DELETE",
    "Erreur proxy DELETE"
  );
};

exports.exportTransactionsCsv = async (req, res) => {
  const txCoreBase = getTxCoreBaseUrl();
  if (!txCoreBase) {
    return res.status(500).json({
      success: false,
      error: "TX_CORE_URL manquant dans la gateway.",
    });
  }

  try {
    const response = await axios.get(
      `${txCoreBase}/api/v1/admin/transactions/export/csv`,
      buildAxiosConfig(req, {
        params: req.query,
        responseType: "stream",
        timeout: 30000,
      })
    );

    if (response.status < 200 || response.status >= 300) {
      logger.error("[Gateway][AdminTx] EXPORT CSV:", {
        status: response.status,
        error: "Erreur proxy EXPORT CSV",
      });

      return res.status(response.status).json({
        success: false,
        error: "Erreur proxy EXPORT CSV",
      });
    }

    res.setHeader(
      "Content-Disposition",
      response.headers["content-disposition"] || 'attachment; filename="export.csv"'
    );
    res.setHeader("Content-Type", response.headers["content-type"] || "text/csv");

    return response.data.pipe(res);
  } catch (err) {
    const status = err.response?.status || 502;
    const error =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      "Erreur proxy EXPORT CSV";

    logger.error("[Gateway][AdminTx] EXPORT CSV:", { status, error });

    return res.status(status).json({ success: false, error });
  }
};