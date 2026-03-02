"use strict";

const mongoose = require("mongoose");

const feeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, lowercase: true, index: true },
    description: { type: String, default: "", trim: true },

    txType: {
      type: String,
      trim: true,
      uppercase: true,
      enum: ["TRANSFER", "DEPOSIT", "WITHDRAW", ""],
      default: "",
      index: true,
    },

    method: {
      type: String,
      trim: true,
      uppercase: true,
      enum: ["MOBILEMONEY", "BANK", "CARD", "INTERNAL", ""],
      default: "",
      index: true,
    },

    provider: { type: String, trim: true, lowercase: true, default: "", index: true },

    country: { type: String, trim: true, lowercase: true, default: "", index: true },
    toCountry: { type: String, trim: true, lowercase: true, default: "", index: true },

    currency: { type: String, trim: true, uppercase: true, default: "XOF", index: true },
    toCurrency: { type: String, trim: true, uppercase: true, default: "", index: true },

    // ✅ fixed / percent / mixed
    type: {
      type: String,
      enum: ["fixed", "percent", "mixed"],
      default: "fixed",
      index: true,
    },

    // Pour fixed = montant fixe
    // Pour percent = % de base
    // Pour mixed = % de base
    amount: { type: Number, required: true, min: 0 },

    // ✅ partie fixe dédiée pour mixed
    fixedAmount: { type: Number, default: 0, min: 0 },

    minFee: { type: Number, default: null, min: 0 },
    maxFee: { type: Number, default: null, min: 0 },

    minAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: null, min: 0 },

    extraPercent: { type: Number, default: 0 },
    extraFixed: { type: Number, default: 0 },

    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0, index: true },

    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

feeSchema.index({
  txType: 1,
  method: 1,
  provider: 1,
  country: 1,
  toCountry: 1,
  currency: 1,
  toCurrency: 1,
  type: 1,
  active: 1,
  priority: -1,
  minAmount: 1,
  maxAmount: 1,
});

feeSchema.pre("validate", function (next) {
  try {
    if (this.provider) this.provider = String(this.provider).trim().toLowerCase();
    if (this.country) this.country = String(this.country).trim().toLowerCase();
    if (this.toCountry) this.toCountry = String(this.toCountry).trim().toLowerCase();
    if (this.currency) this.currency = String(this.currency).trim().toUpperCase();
    if (this.toCurrency) this.toCurrency = String(this.toCurrency).trim().toUpperCase();
    if (this.txType) this.txType = String(this.txType).trim().toUpperCase();
    if (this.method) this.method = String(this.method).trim().toUpperCase();
    if (this.type) this.type = String(this.type).trim().toLowerCase();

    if (
      this.maxAmount !== null &&
      this.maxAmount !== undefined &&
      Number(this.minAmount || 0) > Number(this.maxAmount)
    ) {
      return next(new Error("minAmount ne peut pas être supérieur à maxAmount"));
    }

    if (
      this.minFee !== null &&
      this.maxFee !== null &&
      this.minFee !== undefined &&
      this.maxFee !== undefined &&
      Number(this.minFee) > Number(this.maxFee)
    ) {
      return next(new Error("minFee ne peut pas être supérieur à maxFee"));
    }

    next();
  } catch (e) {
    next(e);
  }
});

feeSchema.pre("save", function (next) {
  if (!this.slug) {
    const parts = [
      this.txType || "alltx",
      this.method || "allmethod",
      this.provider || "anyprovider",
      this.country || "anycountry",
      this.toCountry || "anytocountry",
      this.currency || "XOF",
      this.toCurrency || "anytocurrency",
      this.type || "fixed",
      String(this.amount ?? 0),
      String(this.fixedAmount ?? 0),
    ];

    this.slug = parts.join("-").replace(/\s+/g, "-").toLowerCase();
  }

  next();
});

module.exports = mongoose.models.Fee || mongoose.model("Fee", feeSchema);