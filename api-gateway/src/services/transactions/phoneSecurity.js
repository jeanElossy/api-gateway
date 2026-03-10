"use strict";

/**
 * --------------------------------------------------------------------------
 * Phone / Forward Headers / Deposit trust helpers
 * --------------------------------------------------------------------------
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

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
const logger = reqAny([
  "../../src/logger",
  "../../logger",
  "../../src/utils/logger",
  "../../utils/logger",
]);
const { safeAxiosRequest } = require("./httpClient");

let TrustedDepositNumber = null;
try {
  TrustedDepositNumber = reqAny([
    "../../src/models/TrustedDepositNumber",
    "../../models/TrustedDepositNumber",
  ]);
} catch {
  TrustedDepositNumber = null;
}

const COUNTRY_DIAL = {
  CI: { dial: "+225", localMin: 8, localMax: 10 },
  BF: { dial: "+226", localMin: 8, localMax: 8 },
  ML: { dial: "+223", localMin: 8, localMax: 8 },
  CM: { dial: "+237", localMin: 8, localMax: 9 },
  SN: { dial: "+221", localMin: 9, localMax: 9 },
  BJ: { dial: "+229", localMin: 8, localMax: 8 },
  TG: { dial: "+228", localMin: 8, localMax: 8 },
};

function digitsOnly(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

function normalizePhoneE164(rawPhone, country) {
  const raw = String(rawPhone || "").trim().replace(/\s+/g, "");
  if (!raw) return "";

  if (raw.startsWith("+")) {
    const d = `+${digitsOnly(raw)}`;
    if (d.length < 8 || d.length > 16) return "";
    return d;
  }

  const c = String(country || "").toUpperCase().trim();
  const cfg = COUNTRY_DIAL[c];
  if (!cfg) return "";

  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.length < cfg.localMin || d.length > cfg.localMax) return "";
  return `${cfg.dial}${d}`;
}

function pickUserPrimaryPhoneE164(user, countryFallback) {
  if (!user) return "";

  const direct =
    user.phoneE164 || user.phoneNumber || user.phone || user.mobile || "";
  const ctry = user.country || countryFallback || "";

  let e164 = normalizePhoneE164(direct, ctry);
  if (e164) return e164;

  if (Array.isArray(user.mobiles)) {
    const mm = user.mobiles.find((m) => m && (m.e164 || m.numero));
    if (mm) {
      e164 = normalizePhoneE164(mm.e164 || mm.numero, mm.country || ctry);
      if (e164) return e164;
    }
  }

  return "";
}

function getBaseUrlFromReq(req) {
  const envBase =
    process.env.GATEWAY_URL ||
    process.env.APP_BASE_URL ||
    process.env.GATEWAY_BASE_URL ||
    config.gatewayUrl ||
    "";

  if (envBase) return String(envBase).replace(/\/+$/, "");

  const proto = String(
    req.headers["x-forwarded-proto"] || req.protocol || "https"
  )
    .split(",")[0]
    .trim();

  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();

  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function getUserId(req) {
  return req.user?._id || req.user?.id || null;
}

function safeUUID() {
  if (crypto && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {}
  }

  return (
    Date.now().toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

function auditForwardHeaders(req) {
  const incomingAuth =
    req.headers.authorization || req.headers.Authorization || null;

  const hasAuth =
    !!incomingAuth &&
    String(incomingAuth).toLowerCase() !== "bearer null" &&
    String(incomingAuth).trim().toLowerCase() !== "null";

  const reqId = req.headers["x-request-id"] || req.id || safeUUID();
  const userIdRaw = getUserId(req) || req.headers["x-user-id"] || "";
  const userId = String(userIdRaw || "");

  const internalToken =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  const headers = {
    Accept: "application/json",
    "x-internal-token": internalToken,
    "x-request-id": reqId,
    "x-user-id": userId,
    "x-session-id": req.headers["x-session-id"] || "",
    ...(req.headers["x-device-id"]
      ? { "x-device-id": req.headers["x-device-id"] }
      : {}),
  };

  if (hasAuth) headers.Authorization = incomingAuth;

  return headers;
}

async function fetchOtpStatus({ req, phoneE164, country }) {
  const base = getBaseUrlFromReq(req);
  if (!base) return { ok: false, trusted: false, status: "unknown" };

  const url = `${base}/api/v1/phone-verification/status`;

  try {
    const r = await safeAxiosRequest({
      method: "get",
      url,
      params: { phoneNumber: phoneE164, country },
      headers: auditForwardHeaders(req),
      timeout: 8000,
    });

    const payload = r?.data || {};
    const data = payload?.data || payload;

    const status = String(data?.status || "none").toLowerCase();
    const trusted = !!data?.trusted || status === "trusted";

    return { ok: true, trusted, status, data };
  } catch (e) {
    logger?.warn?.("[Gateway][OTP] status call failed", { message: e?.message });
    return { ok: false, trusted: false, status: "unknown" };
  }
}

async function enforceDepositPhoneTrust(req) {
  const userId = getUserId(req);
  if (!userId) {
    const e = new Error("Non autorisé (utilisateur manquant).");
    e.status = 401;
    throw e;
  }

  const actionNorm = String(req.body?.action || "send").toLowerCase();
  const fundsNorm = String(req.body?.funds || "").toLowerCase();
  const destNorm = String(req.body?.destination || "").toLowerCase();

  if (
    !(actionNorm === "deposit" && fundsNorm === "mobilemoney" && destNorm === "paynoval")
  ) {
    return;
  }

  const rawPhone =
    req.body?.phoneNumber || req.body?.toPhone || req.body?.phone || "";
  const country =
    req.body?.country || req.user?.country || req.user?.selectedCountry || "";

  const phoneE164 = normalizePhoneE164(rawPhone, country);

  if (!phoneE164) {
    const e = new Error(
      "Numéro de dépôt invalide. Format attendu: E.164 (ex: +2250700000000) ou numéro local valide selon le pays."
    );
    e.status = 400;
    e.code = "PHONE_INVALID";
    throw e;
  }

  const userPhoneE164 = pickUserPrimaryPhoneE164(req.user, country);
  const isSameAsUser =
    userPhoneE164 && String(userPhoneE164) === String(phoneE164);

  if (!isSameAsUser) {
    let trusted = false;

    const mongoUp = mongoose.connection.readyState === 1;
    if (mongoUp && TrustedDepositNumber) {
      try {
        const trustedDoc = await TrustedDepositNumber.findOne({
          userId,
          phoneE164,
          status: "trusted",
        }).lean();
        trusted = !!trustedDoc;
      } catch {
        trusted = false;
      }
    }

    if (!trusted) {
      const st = await fetchOtpStatus({ req, phoneE164, country });

      if (st?.trusted) {
        if (mongoose.connection.readyState === 1 && TrustedDepositNumber) {
          try {
            await TrustedDepositNumber.updateOne(
              { userId, phoneE164 },
              {
                $set: {
                  userId,
                  phoneE164,
                  status: "trusted",
                  verifiedAt: new Date(),
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true }
            );
          } catch {}
        }
      } else {
        const pending = String(st?.status || "").toLowerCase() === "pending";

        const e = new Error(
          pending
            ? "Vérification SMS déjà en cours pour ce numéro. Entre le code reçu (ne relance pas l’OTP)."
            : "Ce numéro n’est pas vérifié. Vérifie d’abord le numéro par SMS avant de déposer."
        );

        e.status = 403;
        e.code = pending
          ? "PHONE_VERIFICATION_PENDING"
          : "PHONE_NOT_TRUSTED";
        e.payload = {
          success: false,
          error: e.message,
          code: e.code,
          otpStatus: {
            status: st?.status || (pending ? "pending" : "none"),
            skipStart: pending,
          },
          nextStep: {
            status: "/api/v1/phone-verification/status",
            start: "/api/v1/phone-verification/start",
            verify: "/api/v1/phone-verification/verify",
            phoneNumber: phoneE164,
            country,
            skipStart: pending,
          },
        };
        throw e;
      }
    }
  }

  req.body.phoneNumber = phoneE164;
}

module.exports = {
  COUNTRY_DIAL,
  digitsOnly,
  normalizePhoneE164,
  pickUserPrimaryPhoneE164,
  getBaseUrlFromReq,
  getUserId,
  safeUUID,
  auditForwardHeaders,
  fetchOtpStatus,
  enforceDepositPhoneTrust,
};