"use strict";

const mongoose = require("mongoose");

const fxRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0, index: true },

    txType: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      enum: ["TRANSFER", "DEPOSIT", "WITHDRAW", ""],
      index: true,
    },

    method: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
      enum: ["MOBILEMONEY", "BANK", "CARD", "INTERNAL", ""],
      index: true,
    },

    provider: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    // country = scope général facultatif
    country: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    fromCountry: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    toCountry: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
      index: true,
    },

    fromCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    toCurrency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    minAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: null, min: 0 },

    mode: {
      type: String,
      enum: ["PASS_THROUGH", "OVERRIDE", "MARKUP_PERCENT", "DELTA_PERCENT", "DELTA_ABS"],
      default: "PASS_THROUGH",
      index: true,
    },

    overrideRate: { type: Number, default: null },
    markupPercent: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    deltaAbs: { type: Number, default: 0 },

    lastUsedAt: { type: Date, default: null },
    notes: { type: String, default: "", trim: true },
  },
  { timestamps: true, versionKey: false }
);

fxRuleSchema.index({
  active: 1,
  txType: 1,
  method: 1,
  provider: 1,
  country: 1,
  fromCountry: 1,
  toCountry: 1,
  fromCurrency: 1,
  toCurrency: 1,
  priority: -1,
  updatedAt: -1,
});

fxRuleSchema.pre("validate", function (next) {
  try {
    if (this.txType) this.txType = String(this.txType).trim().toUpperCase();
    if (this.method) this.method = String(this.method).trim().toUpperCase();
    if (this.provider) this.provider = String(this.provider).trim().toLowerCase();
    if (this.country) this.country = String(this.country).trim().toLowerCase();
    if (this.fromCountry) this.fromCountry = String(this.fromCountry).trim().toLowerCase();
    if (this.toCountry) this.toCountry = String(this.toCountry).trim().toLowerCase();
    if (this.fromCurrency) this.fromCurrency = String(this.fromCurrency).trim().toUpperCase();
    if (this.toCurrency) this.toCurrency = String(this.toCurrency).trim().toUpperCase();

    if (
      this.maxAmount !== null &&
      this.maxAmount !== undefined &&
      Number(this.minAmount || 0) > Number(this.maxAmount)
    ) {
      return next(new Error("minAmount ne peut pas être supérieur à maxAmount"));
    }

    if (this.mode === "OVERRIDE" && !(Number(this.overrideRate) > 0)) {
      return next(new Error("overrideRate doit être > 0 en mode OVERRIDE"));
    }

    next();
  } catch (e) {
    next(e);
  }
});

module.exports = mongoose.models.FxRule || mongoose.model("FxRule", fxRuleSchema);