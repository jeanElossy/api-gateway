"use strict";

const mongoose = require("mongoose");

const TrustedDepositNumberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // Numéro en E.164 (ex: +2250700000000)
  phoneE164: { type: String, required: true, trim: true },

  // Statut de vérification “PayNoval OTP”
  status: { type: String, enum: ["pending", "trusted", "blocked"], default: "pending" },

  // Anti-spam / cooldown
  lastSentAt: { type: Date, default: null },
  sentCount: { type: Number, default: 0 },
  blockedUntil: { type: Date, default: null },

  // Audit
  verifiedAt: { type: Date, default: null },
}, { timestamps: true });

// Un numéro trusted par user, unique
TrustedDepositNumberSchema.index({ userId: 1, phoneE164: 1 }, { unique: true });

// Pour retrouver les trusted rapidement
TrustedDepositNumberSchema.index({ userId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model("TrustedDepositNumber", TrustedDepositNumberSchema);
