"use strict";

/**
 * ACCESS TOKEN — the ONE way the gateway verifies a user JWT.
 *
 * Shared by the auth middleware and the rate limiter: a limiter that keyed on
 * an UNVERIFIED `sub` would let anyone spread their traffic over forged
 * accounts. Same algorithm, same issuer/audience, same keyring as `protect`.
 */

const jwt = require("jsonwebtoken");
const config = require("../config");
const { getVerificationKey, readKid } = require("./jwtKeyring");

const JWT_ISSUER = String(process.env.JWT_ISSUER || "").trim();
const JWT_AUDIENCES = String(process.env.JWT_AUDIENCES || process.env.JWT_AUDIENCE || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.PRINCIPAL_JWT_SECRET || config.jwtSecret || "";
}

function buildVerifyOptions() {
  const opts = { algorithms: ["HS256"] };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCES.length) opts.audience = JWT_AUDIENCES;
  return opts;
}

function getBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (!header || typeof header !== "string") return null;

  const s = header.trim();
  if (!s.toLowerCase().startsWith("bearer ")) return null;

  const token = s.slice(7).trim();
  if (!token || token.toLowerCase() === "null") return null;
  return token;
}

function resolveUserIdFromPayload(p) {
  return p?.id || p?._id || p?.sub || p?.user?.id || p?.user?._id || p?.userId || null;
}

/** Throws exactly like `jwt.verify` (TokenExpiredError, JsonWebTokenError…). */
function verifyAccessTokenOrThrow(token) {
  const secret = getJwtSecret();
  if (!secret) throw new Error("JWT secret missing");
  const key = getVerificationKey(readKid(token)) || secret;
  return jwt.verify(token, key, buildVerifyOptions());
}

/**
 * Verified user id of the request, or `null` (no token, invalid, expired).
 * Memoized on the request: the limiter and `protect` do not verify twice.
 */
function verifiedUserId(req) {
  if (req && Object.prototype.hasOwnProperty.call(req, "__verifiedUserId")) {
    return req.__verifiedUserId;
  }

  let userId = null;
  const token = getBearerToken(req);

  if (token) {
    try {
      const id = resolveUserIdFromPayload(verifyAccessTokenOrThrow(token));
      userId = id ? String(id) : null;
    } catch {
      // Invalid or expired: treated as anonymous; `protect` answers the 401.
      userId = null;
    }
  }

  if (req) req.__verifiedUserId = userId;
  return userId;
}

module.exports = {
  JWT_ISSUER,
  JWT_AUDIENCES,
  getJwtSecret,
  buildVerifyOptions,
  getBearerToken,
  resolveUserIdFromPayload,
  verifyAccessTokenOrThrow,
  verifiedUserId,
};
