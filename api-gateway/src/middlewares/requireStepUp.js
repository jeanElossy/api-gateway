"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const PURPOSE = "service-control-step-up";
const AUDIENCE = "paynoval:service-control";

/**
 * Fresh 2FA code on a route the gateway relays straight to Tx-Core. The token
 * is issued by the backend (`services/serviceControl/stepUp.js`, same derived
 * key and same claims): 5 minutes, bound to this account.
 */
function stepUpKey(secret = process.env.JWT_SECRET) {
  return crypto.createHmac("sha256", String(secret || "")).update(PURPOSE).digest();
}

function isValidStepUp(token, userId, secret = process.env.JWT_SECRET) {
  if (!secret || !userId) return false;

  try {
    const payload = jwt.verify(String(token || ""), stepUpKey(secret), {
      algorithms: ["HS256"],
      audience: AUDIENCE,
      subject: String(userId),
    });
    return payload?.purpose === PURPOSE;
  } catch {
    return false;
  }
}

function requireStepUp(req, res, next) {
  if (isValidStepUp(req.headers["x-step-up-token"], req.user?._id || req.user?.id)) return next();

  return res.status(403).json({
    success: false,
    code: "STEP_UP_REQUIRED",
    error: "Confirmez cette action avec votre code de double authentification.",
  });
}

module.exports = { AUDIENCE, PURPOSE, isValidStepUp, requireStepUp, stepUpKey };
