"use strict";

const mongoose = require("mongoose");

const feeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, trim: true, lowercase: true, index: true },
    description: { type: String, default: "" },

    provider: { type: String, trim: true, lowercase: true, default: "" },
    country: { type: String, trim: true, lowercase: true, default: "" },

    currency: { type: String, default: "XOF", uppercase: true },

    type: { type: String, enum: ["fixed", "percent"], default: "fixed" },

    amount: { type: Number, required: true }, // fixed OU percent

    minFee: { type: Number, default: null },
    maxFee: { type: Number, default: null },

    minAmount: { type: Number, default: 0 },
    maxAmount: { type: Number, default: null },

    // ✅ AJUSTEMENTS ADMIN (positif ou négatif)
    extraPercent: { type: Number, default: 0 }, // ex: +0.3 ou -0.2
    extraFixed: { type: Number, default: 0 },   // ex: +200 ou -100 (dans currency)

    active: { type: Boolean, default: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

feeSchema.index({
  slug: 1,
  provider: 1,
  country: 1,
  currency: 1,
  type: 1,
  active: 1,
  minAmount: 1,
  maxAmount: 1,
});

// Auto-slug si non fourni
feeSchema.pre("save", function (next) {
  if (!this.slug) {
    const parts = [
      this.provider || "any",
      this.country || "any",
      this.currency || "XOF",
      this.type || "fixed",
      String(this.amount),
    ];
    this.slug = parts.join("-").replace(/\s+/g, "-").toLowerCase();
  }
  next();
});

module.exports = mongoose.model("Fee", feeSchema);
