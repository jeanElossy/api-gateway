// File: api-gateway/src/models/Transaction.js
"use strict";

const mongoose = require("mongoose");

const toISO = (v) => {
  const s = String(v || "").trim();
  if (!s) return undefined;
  return s.toUpperCase();
};


const MoneyAtomSchema = new mongoose.Schema(
  {
    amount: { type: Number },
    currency: { type: String, set: toISO }, // ISO: EUR, XOF, CAD...
  },
  { _id: false }
);

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  // ✅ rôles (important pour historique / referral)
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  initiatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  provider: {
    type: String,
    required: true,
    enum: [
      "paynoval",
      "stripe",
      "bank",
      "mobilemoney",
      "visa_direct",
      "cashin",
      "cashout",
      "stripe2momo",
      "flutterwave",
    ],
  },

  // ✅ FLOW (ajout)
  action: {
    type: String,
    enum: ["deposit", "withdraw", "send"],
    default: "send",
  },
  funds: { type: String },
  destination: { type: String },
  providerSelected: { type: String },

  // ------------------------------------------------------------------
  // ✅ LEGACY (compat) : NE PLUS UTILISER EN UI
  // ------------------------------------------------------------------
  amount: { type: Number, required: true },
  fees: { type: Number },
  netAmount: { type: Number },
  currency: { type: String, set: toISO }, // legacy (doit être ISO)

  // ------------------------------------------------------------------
  // ✅ NOUVEAU: multi-devise stable (ISO)
  // ------------------------------------------------------------------
  amountSource: { type: Number },
  currencySource: { type: String, set: toISO },
  feeSource: { type: Number },
  amountTarget: { type: Number },
  currencyTarget: { type: String, set: toISO },
  fxRateSourceToTarget: { type: Number },

  // Vue “money”
  money: {
    source: { type: MoneyAtomSchema, default: undefined },
    feeSource: { type: MoneyAtomSchema, default: undefined },
    target: { type: MoneyAtomSchema, default: undefined },
    fxRateSourceToTarget: { type: Number, default: undefined },
  },

  status: {
    type: String,
    enum: ["pending", "confirmed", "canceled", "failed", "refunded"],
    default: "pending",
  },

  toEmail: { type: String },
  toIBAN: { type: String },
  toPhone: { type: String },
  operator: { type: String },
  country: { type: String },

  reference: { type: String },
  providerTxId: { type: String },

  requiresSecurityValidation: { type: Boolean, default: true },
  securityQuestion: { type: String },
  securityCodeHash: { type: String },
  securityAttempts: { type: Number, default: 0 },
  securityLockedUntil: { type: Date, default: null },

  confirmedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelReason: { type: String },

  meta: { type: Object },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ✅ updatedAt automatique
TransactionSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});
TransactionSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedAt: new Date() });
  next();
});

// Index
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });
TransactionSchema.index({ provider: 1, providerTxId: 1 }, { sparse: true });
TransactionSchema.index({ ownerUserId: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ initiatorUserId: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ createdBy: 1, createdAt: -1 });
TransactionSchema.index({ receiver: 1, createdAt: -1 });
TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });
TransactionSchema.index({ providerSelected: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ action: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ currencySource: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ currencyTarget: 1, createdAt: -1 }, { sparse: true });

module.exports = mongoose.model("Transaction", TransactionSchema);
