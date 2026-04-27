// File: controllers/adminCompliance.controller.js
"use strict";

const axios = require("axios");

function reqAny(paths, fallback = null) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(p);
    } catch {}
  }
  return fallback;
}

const logger =
  reqAny(["../src/logger", "../logger", "../src/utils/logger", "../utils/logger"], console) ||
  console;

const config = reqAny(["../src/config", "../config"], {}) || {};

const COMPLIANCE_ALERT_CODES = [
  "COMPLIANCE_REVIEW_REQUIRED",
  "SANCTIONS_SCREENING_BLOCKED",
  "PEP_SANCTIONED",
  "BLACKLISTED",
  "BLACKLISTED_USER",
  "BLACKLISTED_EMAIL",
  "BLACKLISTED_PHONE",
  "BLACKLISTED_IBAN",
  "BLACKLISTED_COUNTRY",
  "BLACKLISTED_NAME",
  "BLACKLISTED_SENDER_EMAIL",
  "BLACKLISTED_SENDER_PHONE",
  "RISKY_COUNTRY",
  "AML_SINGLE_LIMIT",
  "AML_DAILY_LIMIT",
  "AML_RATE_LIMIT_1H",
  "AML_STRUCTURING",
  "AML_ML_BLOCK",
];

function safeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function stripTrailingSlash(value) {
  return safeString(value).replace(/\/+$/, "");
}

function getTxCoreBaseUrl() {
  return stripTrailingSlash(
    process.env.TX_CORE_SERVICE_URL ||
      process.env.TRANSACTIONS_SERVICE_URL ||
      process.env.TX_SERVICE_URL ||
      process.env.PAYNOVAL_TRANSACTIONS_URL ||
      config.microservices?.transactions ||
      config.microservices?.txCore ||
      config.microservices?.txcore ||
      config.microservices?.paynovalTransactions ||
      ""
  );
}

function getInternalToken() {
  return (
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    ""
  );
}

function buildInternalHeaders(req) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-internal-token": getInternalToken(),
    "x-request-id":
      req.headers["x-request-id"] ||
      req.headers["x-correlation-id"] ||
      `cmp-${Date.now().toString(16)}`,
  };
}

function toArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  return [];
}

function getTotal(payload, fallback = 0) {
  return (
    Number(payload?.total) ||
    Number(payload?.count) ||
    Number(payload?.meta?.total) ||
    Number(payload?.pagination?.total) ||
    Number(payload?.data?.total) ||
    Number(payload?.data?.meta?.total) ||
    fallback
  );
}

function normalizeUpper(value) {
  return safeString(value).toUpperCase();
}

function getNestedCandidates(tx = {}) {
  return [
    tx.code,
    tx.errorCode,
    tx.reasonCode,
    tx.complianceCode,
    tx.flagCode,
    tx.statusReason,
    tx.cancelReason,
    tx.providerStatus,
    tx.flagReason,
    tx.reason,
    tx.message,
    tx.error,

    tx.metadata?.code,
    tx.metadata?.errorCode,
    tx.metadata?.reasonCode,
    tx.metadata?.complianceCode,
    tx.metadata?.flagCode,
    tx.metadata?.reason,
    tx.metadata?.message,
    tx.metadata?.flagReason,
    tx.metadata?.compliance?.code,
    tx.metadata?.compliance?.reason,
    tx.metadata?.sanctionsScreening?.code,
    tx.metadata?.sanctionsScreening?.reason,
    tx.metadata?.blacklistHit?.code,
    tx.metadata?.blacklistHit?.reason,

    tx.meta?.code,
    tx.meta?.errorCode,
    tx.meta?.reasonCode,
    tx.meta?.complianceCode,
    tx.meta?.flagCode,
    tx.meta?.reason,
    tx.meta?.message,
    tx.meta?.sanctionsScreening?.code,
    tx.meta?.sanctionsScreening?.reason,
    tx.meta?.blacklistHit?.code,
  ].filter(Boolean);
}

function getComplianceCode(tx = {}) {
  const candidates = getNestedCandidates(tx).map(normalizeUpper);

  const direct = candidates.find((value) =>
    COMPLIANCE_ALERT_CODES.includes(value)
  );

  if (direct) return direct;

  const blob = JSON.stringify(tx || {}).toUpperCase();

  const embedded = COMPLIANCE_ALERT_CODES.find((code) => blob.includes(code));
  if (embedded) return embedded;

  if (blob.includes("SANCTION")) return "SANCTIONS_SCREENING_BLOCKED";
  if (blob.includes("BLACKLIST")) return "BLACKLISTED";
  if (blob.includes("PEP")) return "PEP_SANCTIONED";
  if (blob.includes("COMPLIANCE")) return "COMPLIANCE_REVIEW_REQUIRED";
  if (blob.includes("PAYS À RISQUE") || blob.includes("PAYS A RISQUE")) {
    return "RISKY_COUNTRY";
  }

  return "";
}

function isComplianceTransaction(tx = {}) {
  return Boolean(getComplianceCode(tx));
}

function getRiskStatus(code) {
  if (
    code === "SANCTIONS_SCREENING_BLOCKED" ||
    code === "PEP_SANCTIONED" ||
    String(code || "").includes("BLACKLISTED")
  ) {
    return "blocked";
  }

  if (code === "COMPLIANCE_REVIEW_REQUIRED") return "review";
  return "alert";
}

function filterByQuery(tx, q) {
  const query = safeString(q).toLowerCase();
  if (!query) return true;

  const blob = JSON.stringify(tx || {}).toLowerCase();
  return blob.includes(query);
}

function filterComplianceTransactions(list = [], filters = {}) {
  const requestedCode = safeString(filters.code).toUpperCase();
  const requestedStatus = safeString(filters.status).toLowerCase();
  const q = safeString(filters.q || filters.search);

  return list
    .filter(isComplianceTransaction)
    .filter((tx) => {
      const code = getComplianceCode(tx);

      if (requestedCode && requestedCode !== "ALL" && code !== requestedCode) {
        return false;
      }

      if (requestedStatus && requestedStatus !== "all") {
        if (getRiskStatus(code) !== requestedStatus) return false;
      }

      return filterByQuery(tx, q);
    })
    .map((tx) => ({
      ...tx,
      complianceCode: tx.complianceCode || getComplianceCode(tx),
      complianceRiskStatus: getRiskStatus(getComplianceCode(tx)),
    }));
}

function buildStats(items = []) {
  const stats = {
    total: items.length,
    review: 0,
    blocked: 0,
    sanctions: 0,
    blacklist: 0,
    riskyCountry: 0,
    aml: 0,
  };

  for (const tx of items) {
    const code = getComplianceCode(tx);

    if (code === "COMPLIANCE_REVIEW_REQUIRED") stats.review += 1;

    if (code === "SANCTIONS_SCREENING_BLOCKED" || code === "PEP_SANCTIONED") {
      stats.sanctions += 1;
      stats.blocked += 1;
    }

    if (String(code).includes("BLACKLISTED") || code === "BLACKLISTED") {
      stats.blacklist += 1;
      stats.blocked += 1;
    }

    if (code === "RISKY_COUNTRY") {
      stats.riskyCountry += 1;
      stats.blocked += 1;
    }

    if (String(code).startsWith("AML_")) stats.aml += 1;
  }

  return stats;
}

async function fetchNativeTxCoreCompliance(req, params) {
  const baseUrl = getTxCoreBaseUrl();
  if (!baseUrl) return null;

  const url = `${baseUrl}/api/v1/internal/admin/compliance/transactions`;

  try {
    const response = await axios.get(url, {
      params,
      timeout: 20000,
      headers: buildInternalHeaders(req),
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status === 404) return null;

    if (response.status >= 400) {
      const error = new Error(
        response.data?.message ||
          response.data?.error ||
          "Erreur tx-core compliance"
      );
      error.status = response.status;
      error.data = response.data;
      throw error;
    }

    return response.data;
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

async function fetchTxCoreTransactionsFallback(req, params) {
  const baseUrl = getTxCoreBaseUrl();

  if (!baseUrl) {
    const error = new Error("TX-Core service URL manquant.");
    error.status = 503;
    throw error;
  }

  const url = `${baseUrl}/api/v1/internal/admin/transactions`;

  const response = await axios.get(url, {
    params: {
      page: 1,
      limit: Math.min(500, Math.max(100, Number(params.limit || 200))),
      archived: "all",
      sort: "-createdAt",
    },
    timeout: 25000,
    headers: buildInternalHeaders(req),
  });

  return response.data;
}

exports.listComplianceTransactions = async function listComplianceTransactions(
  req,
  res
) {
  const page = toInt(req.query.page, 1, 1, 100000);
  const limit = toInt(req.query.limit, 50, 1, 200);

  const params = {
    page,
    limit,
    code: safeString(req.query.code || "all"),
    status: safeString(req.query.status || "all"),
    q: safeString(req.query.q || req.query.search || ""),
    from: safeString(req.query.from || ""),
    to: safeString(req.query.to || ""),
  };

  try {
    const nativePayload = await fetchNativeTxCoreCompliance(req, params);

    if (nativePayload) {
      const items = toArray(nativePayload);
      const total = getTotal(nativePayload, items.length);

      return res.status(200).json({
        success: true,
        source: "tx-core-native",
        data: items,
        items,
        total,
        page,
        limit,
        stats: nativePayload.stats || buildStats(items),
        codes: COMPLIANCE_ALERT_CODES,
      });
    }

    const txPayload = await fetchTxCoreTransactionsFallback(req, params);
    const rawItems = toArray(txPayload);
    const filtered = filterComplianceTransactions(rawItems, params);

    const start = (page - 1) * limit;
    const paged = filtered.slice(start, start + limit);

    return res.status(200).json({
      success: true,
      source: "gateway-filtered-transactions",
      data: paged,
      items: paged,
      total: filtered.length,
      page,
      limit,
      stats: buildStats(filtered),
      codes: COMPLIANCE_ALERT_CODES,
    });
  } catch (err) {
    logger.error?.("[Gateway][Compliance] list failed", {
      status: err?.response?.status || err?.status || 500,
      message: err?.response?.data || err?.data || err?.message || String(err),
    });

    return res.status(err?.status || err?.response?.status || 502).json({
      success: false,
      code: "COMPLIANCE_TRANSACTIONS_UNAVAILABLE",
      error:
        err?.response?.data?.error ||
        err?.data?.error ||
        err?.message ||
        "Impossible de charger les transactions conformité.",
    });
  }
};