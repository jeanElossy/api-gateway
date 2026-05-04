// File: src/middlewares/requireTransactionEligibility.js
"use strict";

/**
 * Bloque les transactions si le profil utilisateur n’est pas complet.
 *
 * Règles :
 * - email vérifié obligatoire
 * - téléphone vérifié obligatoire
 * - compte personnel : KYC obligatoire
 * - compte business : KYB obligatoire
 * - compte bloqué / gelé / suspendu / masqué des transferts : interdit
 *
 * Important :
 * Le gateway appelle le backend principal /api/v1/users/me pour avoir
 * un profil frais, au lieu de se fier uniquement au JWT.
 */

const axios = require("axios");

let config = {};
try {
  config = require("../config");
} catch {}

let logger = console;
try {
  logger = require("../logger");
} catch {}

const PROFILE_TIMEOUT_MS = Number(
  process.env.TRANSACTION_PROFILE_CHECK_TIMEOUT_MS || 8000
);

function safeString(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function low(value) {
  return safeString(value).toLowerCase();
}

function stripTrailingSlash(value) {
  return safeString(value).replace(/\/+$/, "");
}

function joinUrl(base, path) {
  const cleanBase = stripTrailingSlash(base);
  const cleanPath = String(path || "").startsWith("/")
    ? String(path || "")
    : `/${String(path || "")}`;

  if (cleanBase.endsWith("/api/v1") && cleanPath.startsWith("/api/v1/")) {
    return `${cleanBase}${cleanPath.replace(/^\/api\/v1/, "")}`;
  }

  return `${cleanBase}${cleanPath}`;
}

function getPrincipalBaseUrl() {
  return (
    process.env.PRINCIPAL_API_BASE_URL ||
    process.env.BACKEND_PRINCIPAL_URL ||
    process.env.PAYNOVAL_SERVICE_URL ||
    config.principalUrl ||
    config.microservices?.principal ||
    config.microservices?.paynoval ||
    ""
  );
}

function pickAuthHeader(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  const value = Array.isArray(auth) ? auth[0] : auth;

  if (!value || String(value).trim().toLowerCase() === "bearer null") {
    return "";
  }

  return String(value).trim();
}

function pickRequestId(req) {
  return (
    req.headers["x-request-id"] ||
    req.headers["x-correlation-id"] ||
    req.id ||
    `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffff).toString(
      16
    )}`
  );
}

function extractUserFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  return (
    payload.user ||
    payload.profile ||
    payload.data?.user ||
    payload.data?.profile ||
    payload.data ||
    payload
  );
}

function isPositiveFlag(value) {
  if (value === true) return true;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0;
  }

  const text = low(value);

  if (!text) return false;

  return [
    "true",
    "yes",
    "oui",
    "verified",
    "verifie",
    "vérifié",
    "validated",
    "valide",
    "validé",
    "approved",
    "complete",
    "completed",
    "success",
    "ok",
    "active",
  ].includes(text);
}

function normalizeStatus(value) {
  return low(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");
}

function isApprovedStatus(value) {
  const status = normalizeStatus(value);

  return [
    "approved",
    "validated",
    "valide",
    "verified",
    "verifie",
    "complete",
    "completed",
    "success",
    "accepted",
    "active",
  ].includes(status);
}

function isBlockedAccountStatus(value) {
  const status = normalizeStatus(value);

  return [
    "blocked",
    "bloque",
    "frozen",
    "gele",
    "gelé",
    "suspended",
    "suspendu",
    "disabled",
    "disable",
    "deleted",
    "supprime",
    "banned",
    "closed",
    "inactive",
    "rejected",
    "denied",
  ].includes(status);
}

function isPendingAccountStatus(value) {
  const status = normalizeStatus(value);
  return status === "pending";
}

function isBusinessUser(user = {}) {
  const type = normalizeStatus(
    user.userType || user.type || user.accountType || user.profile?.userType
  );

  const role = normalizeStatus(user.role);

  return (
    user.isBusiness === true ||
    type === "entreprise" ||
    type === "business" ||
    type === "company" ||
    type === "merchant" ||
    role === "business"
  );
}

function isEmailVerified(user = {}) {
  return (
    isPositiveFlag(user.emailVerified) ||
    isPositiveFlag(user.isEmailVerified) ||
    isPositiveFlag(user.email_verifie) ||
    isPositiveFlag(user.emailVerifiedAt) ||
    isPositiveFlag(user.emailVerification?.verified) ||
    isPositiveFlag(user.emailVerification?.status) ||
    isPositiveFlag(user.verifications?.email?.verified) ||
    isPositiveFlag(user.verifications?.email?.status) ||
    isPositiveFlag(user.profile?.emailVerified) ||
    isPositiveFlag(user.profile?.emailVerifiedAt)
  );
}

function isPhoneVerified(user = {}) {
  return (
    isPositiveFlag(user.phoneVerified) ||
    isPositiveFlag(user.isPhoneVerified) ||
    isPositiveFlag(user.phone_verifie) ||
    isPositiveFlag(user.phoneVerifiedAt) ||
    isPositiveFlag(user.phoneVerification?.verified) ||
    isPositiveFlag(user.phoneVerification?.status) ||
    isPositiveFlag(user.verifications?.phone?.verified) ||
    isPositiveFlag(user.verifications?.phone?.status) ||
    isPositiveFlag(user.profile?.phoneVerified) ||
    isPositiveFlag(user.profile?.phoneVerifiedAt)
  );
}

function isKycVerified(user = {}) {
  const level = Number(user.kycLevel || user.profile?.kycLevel || 0);

  return (
    level >= 2 ||
    isApprovedStatus(user.kycStatus) ||
    isApprovedStatus(user.kyc?.status) ||
    isApprovedStatus(user.kyc?.verificationStatus) ||
    isApprovedStatus(user.verifications?.kyc?.status) ||
    isPositiveFlag(user.kycVerified) ||
    isPositiveFlag(user.isKycVerified)
  );
}

function isKybVerified(user = {}) {
  const businessLevel = Number(
    user.businessKYBLevel ||
      user.business?.businessKYBLevel ||
      user.kybLevel ||
      0
  );

  return (
    businessLevel >= 2 ||
    isApprovedStatus(user.kybStatus) ||
    isApprovedStatus(user.businessStatus) ||
    isApprovedStatus(user.kyb?.status) ||
    isApprovedStatus(user.kyb?.verificationStatus) ||
    isApprovedStatus(user.business?.kybStatus) ||
    isApprovedStatus(user.business?.businessStatus) ||
    isApprovedStatus(user.verifications?.kyb?.status) ||
    isPositiveFlag(user.kybVerified) ||
    isPositiveFlag(user.isKybVerified)
  );
}

function isFrozenNow(user = {}) {
  if (!user.frozenUntil) return false;

  const d = new Date(user.frozenUntil);
  if (!Number.isFinite(d.getTime())) return false;

  return d > new Date();
}

function isAccountBlocked(user = {}) {
  return (
    user.isBlocked === true ||
    user.blocked === true ||
    user.isLoginDisabled === true ||
    user.isDeleted === true ||
    !!user.deletedAt ||
    user.hiddenFromTransfers === true ||
    isFrozenNow(user) ||
    isBlockedAccountStatus(user.status) ||
    isBlockedAccountStatus(user.accountStatus) ||
    isBlockedAccountStatus(user.staffStatus)
  );
}

function buildEligibilityFailure(user = {}) {
  const missing = [];

  if (!user || typeof user !== "object") {
    missing.push({
      code: "USER_PROFILE_NOT_FOUND",
      message: "Profil utilisateur introuvable.",
    });

    return missing;
  }

  if (isAccountBlocked(user)) {
    missing.push({
      code: "ACCOUNT_BLOCKED",
      message:
        "Votre compte est bloqué, gelé, suspendu ou inactif. Les transactions sont indisponibles.",
    });
  }

  if (isPendingAccountStatus(user.accountStatus)) {
    missing.push({
      code: "ACCOUNT_PENDING",
      message:
        "Votre compte est en attente de validation. Les transactions seront disponibles après activation complète.",
    });
  }

  if (!isEmailVerified(user)) {
    missing.push({
      code: "EMAIL_NOT_VERIFIED",
      message:
        "Veuillez vérifier votre adresse email avant d’effectuer une transaction.",
    });
  }

  if (!isPhoneVerified(user)) {
    missing.push({
      code: "PHONE_NOT_VERIFIED",
      message:
        "Veuillez vérifier votre numéro de téléphone avant d’effectuer une transaction.",
    });
  }

  if (isBusinessUser(user)) {
    if (!isKybVerified(user)) {
      missing.push({
        code: "KYB_REQUIRED",
        message:
          "Votre vérification d’entreprise KYB doit être validée avant d’effectuer une transaction.",
      });
    }
  } else if (!isKycVerified(user)) {
    missing.push({
      code: "KYC_REQUIRED",
      message:
        "Votre vérification d’identité KYC doit être validée avant d’effectuer une transaction.",
    });
  }

  return missing;
}

async function fetchFreshProfile(req) {
  const baseUrl = getPrincipalBaseUrl();

  if (!baseUrl) {
    const error = new Error(
      "Backend principal non configuré pour vérifier le profil utilisateur."
    );
    error.code = "PRINCIPAL_PROFILE_SERVICE_MISSING";
    error.status = 503;
    throw error;
  }

  const authHeader = pickAuthHeader(req);

  if (!authHeader) {
    const error = new Error("Token utilisateur manquant.");
    error.code = "AUTH_REQUIRED";
    error.status = 401;
    throw error;
  }

  const url = joinUrl(baseUrl, "/api/v1/users/me");

  const response = await axios.get(url, {
    timeout: PROFILE_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      "x-request-id": pickRequestId(req),
      "x-gateway-profile-check": "1",
      "x-internal-token":
        process.env.GATEWAY_INTERNAL_TOKEN ||
        process.env.INTERNAL_TOKEN ||
        config.internalToken ||
        "",
    },
  });

  const user = extractUserFromPayload(response.data);

  if (!user || typeof user !== "object") {
    const error = new Error("Profil utilisateur introuvable.");
    error.code = "USER_PROFILE_NOT_FOUND";
    error.status = 401;
    throw error;
  }

  return user;
}

function getFailureHttpStatus(code) {
  if (code === "ACCOUNT_BLOCKED") return 403;
  if (code === "ACCOUNT_PENDING") return 403;
  if (code === "USER_PROFILE_NOT_FOUND") return 401;
  return 428;
}

function normalizeUserForTransactions(user = {}) {
  const emailVerified = isEmailVerified(user);
  const phoneVerified = isPhoneVerified(user);
  const businessUser = isBusinessUser(user);
  const kycVerified = isKycVerified(user);
  const kybVerified = isKybVerified(user);

  const userId = safeString(user._id || user.id || user.userId);

  return {
    ...user,

    _id: user._id || userId,
    id: userId,
    userId,

    emailVerified,
    isEmailVerified: emailVerified,

    phoneVerified,
    isPhoneVerified: phoneVerified,

    kycVerified,
    isKycVerified: kycVerified,

    kybVerified,
    isKybVerified: kybVerified,

    isBusiness: businessUser,

    accountStatus: user.accountStatus || user.status || "active",
  };
}

module.exports = async function requireTransactionEligibility(req, res, next) {
  try {
    const freshProfile = await fetchFreshProfile(req);

    const mergedUser = {
      ...(req.user && typeof req.user === "object" ? req.user : {}),
      ...(freshProfile && typeof freshProfile === "object" ? freshProfile : {}),
    };

    const normalizedUser = normalizeUserForTransactions(mergedUser);
    const failures = buildEligibilityFailure(normalizedUser);

    if (failures.length > 0) {
      const first = failures[0];

      return res.status(getFailureHttpStatus(first.code)).json({
        success: false,
        code: first.code,
        error: first.message,
        message: first.message,
        details: failures,
        requiresVerification: true,
      });
    }

    req.user = normalizedUser;
    req.verifiedUserProfile = normalizedUser;

    req.transactionEligibility = {
      ok: true,
      checkedAt: new Date().toISOString(),
      emailVerified: normalizedUser.emailVerified,
      phoneVerified: normalizedUser.phoneVerified,
      kycVerified: normalizedUser.kycVerified,
      kybVerified: normalizedUser.kybVerified,
      userType:
        normalizedUser.userType ||
        normalizedUser.type ||
        normalizedUser.accountType ||
        null,
      isBusiness: normalizedUser.isBusiness,
      accountStatus: normalizedUser.accountStatus || null,
    };

    try {
      logger.info?.("[Gateway][TX eligibility] profile OK", {
        userId: normalizedUser._id || normalizedUser.id || null,
        email: normalizedUser.email || null,
        emailVerified: normalizedUser.emailVerified,
        phoneVerified: normalizedUser.phoneVerified,
        kycVerified: normalizedUser.kycVerified,
        kybVerified: normalizedUser.kybVerified,
        isBusiness: normalizedUser.isBusiness,
        accountStatus: normalizedUser.accountStatus || null,
      });
    } catch {}

    return next();
  } catch (err) {
    const status = err?.response?.status || err?.status || 503;

    logger.error?.("[Gateway][TX eligibility] profile check failed", {
      status,
      code: err?.code || null,
      responseData: err?.response?.data || null,
      message: err?.message || String(err),
      userId: req.user?._id || req.user?.id || null,
    });

    return res.status(status === 401 ? 401 : 503).json({
      success: false,
      code:
        status === 401
          ? "AUTH_REQUIRED"
          : err?.code || "PROFILE_CHECK_UNAVAILABLE",
      error:
        status === 401
          ? "Merci de vous connecter pour effectuer une transaction."
          : "Impossible de vérifier votre profil. Veuillez réessayer dans quelques instants.",
      message:
        status === 401
          ? "Merci de vous connecter pour effectuer une transaction."
          : "Impossible de vérifier votre profil. Veuillez réessayer dans quelques instants.",
    });
  }
};