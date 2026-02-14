"use strict";

const axios = require("axios");

/**
 * Proxy pur: le gateway ne stocke rien.
 * Il forward vers TX-Core (service "transactions").
 *
 * ENV attendues:
 *  - TRANSACTIONS_API_BASE_URL (recommandé)  ex: https://tx-core.onrender.com/api/v1
 *    ou TX_CORE_URL / TRANSACTIONS_SERVICE_URL (fallback)
 *
 *  - INTERNAL_TOKEN / GATEWAY_INTERNAL_TOKEN (déjà géré par validateInternalToken)
 */

function stripTrailingSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function getTxCoreBaseUrl() {
  return (
    process.env.TRANSACTIONS_API_BASE_URL ||
    process.env.TRANSACTIONS_SERVICE_URL ||
    process.env.TX_CORE_URL ||
    process.env.TXCORE_URL ||
    ""
  );
}

function pickReqId(req) {
  return (
    req.headers["x-request-id"] ||
    req.id ||
    `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
  );
}

function safeString(v, max = 300) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizePayload(body = {}) {
  const b = body && typeof body === "object" ? body : {};

  const provider = safeString(b.provider, 80);
  const reference = safeString(b.reference, 200);

  const amount = Number(b.amount);
  const status = safeString(b.status, 40) || "confirmed";
  const currency = safeString(b.currency, 8).toUpperCase() || undefined;
  const operator = safeString(b.operator, 60) || undefined;
  const country = safeString(b.country, 80) || undefined;

  // Compat IDs: le gateway ne valide pas en ObjectId ici (le TX-Core le fera si besoin)
  const userId = b.userId ?? null;
  const createdBy = b.createdBy ?? null;

  // ✅ receiverUserId stable + receiver legacy
  const receiverUserId = b.receiverUserId ?? b.receiver ?? null;
  const receiver = b.receiver ?? receiverUserId ?? null;

  const fees = typeof b.fees === "number" ? b.fees : (typeof b.meta?.feeAmount === "number" ? b.meta.feeAmount : undefined);
  const netAmount = typeof b.netAmount === "number" ? b.netAmount : (typeof b.meta?.netToVault === "number" ? b.meta.netToVault : undefined);

  const meta = b.meta && typeof b.meta === "object" ? b.meta : {};

  return {
    provider,
    reference,
    amount,
    status,
    currency,
    operator,
    country,
    userId,
    createdBy,
    receiver,
    receiverUserId,
    requiresSecurityValidation: !!b.requiresSecurityValidation,
    providerTxId: b.providerTxId ? safeString(b.providerTxId, 200) : undefined,
    fees,
    netAmount,
    meta,
  };
}

function validateMinimal(p) {
  if (!p.provider) return "provider requis";
  if (!p.reference) return "reference requis";
  if (!Number.isFinite(p.amount) || p.amount <= 0) return "amount invalide";
  if (!p.userId) return "userId requis";
  return null;
}

/**
 * POST /internal/transactions/log
 * POST /api/v1/internal/transactions/log
 * -> forward vers TX-Core
 */
exports.proxyLogInternalTransaction = async (req, res) => {
  const base = stripTrailingSlash(getTxCoreBaseUrl());
  if (!base) {
    return res.status(500).json({
      success: false,
      error:
        "TX-Core non configuré. Définis TRANSACTIONS_API_BASE_URL (ou TX_CORE_URL).",
    });
  }

  const normalized = normalizePayload(req.body || {});
  const errMsg = validateMinimal(normalized);
  if (errMsg) {
    return res.status(400).json({ success: false, error: errMsg });
  }

  // ✅ endpoint TX-Core cible (tu peux adapter)
  // Recommandé: créer côté TX-Core: POST /internal/transactions/log
  // ou /api/v1/internal/transactions/log selon ton design.
  const targetCandidates = [
    `${base}/internal/transactions/log`,
    `${base}/api/v1/internal/transactions/log`,
  ];

  const reqId = pickReqId(req);

  // Forward internal token et request-id
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-request-id": reqId,
  };

  const internalToken =
    req.headers["x-internal-token"] ||
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    "";

  if (internalToken) headers["x-internal-token"] = internalToken;

  // x-user-id utile côté tx-core logs
  const userIdHeader =
    req.headers["x-user-id"] ||
    (req.user?._id ? String(req.user._id) : "") ||
    (req.user?.id ? String(req.user.id) : "");
  if (userIdHeader) headers["x-user-id"] = userIdHeader;

  let lastResp = null;

  for (const url of targetCandidates) {
    try {
      const resp = await axios.post(url, normalized, {
        headers,
        timeout: 12000,
        validateStatus: () => true,
      });

      // Si route absente, on essaye le next
      if (resp.status === 404) {
        lastResp = resp;
        continue;
      }

      // On forward la réponse du TX-Core telle quelle
      return res.status(resp.status).json(resp.data);
    } catch (e) {
      lastResp = { status: 502, data: { success: false, error: e.message } };
    }
  }

  // Si aucune route dispo
  return res.status(502).json({
    success: false,
    error:
      "Impossible de logger: TX-Core indisponible ou routes /internal/transactions/log absentes.",
    details: lastResp?.data || null,
  });
};
