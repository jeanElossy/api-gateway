// File: api-gateway/src/middlewares/requirePublicSignature.js
"use strict";

const config = require("../config"); // ✅ bon chemin

module.exports = function requirePublicSignature(req, res, next) {
  const out = config.verifyPublicSignature(req);

  if (!out.ok) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized (public signature required)",
      reason: out.reason,
      age: out.age,
    });
  }

  req.publicSig = out;
  return next();
};
