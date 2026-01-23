"use strict";

const mongoose = require("mongoose");

const PricingQuoteSchema = new mongoose.Schema(
  {
    quoteId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    status: {
      type: String,
      enum: ["ACTIVE", "USED", "EXPIRED"],
      default: "ACTIVE",
      index: true,
    },

    request: {
      txType: { type: String, required: true },
      amount: { type: Number, required: true },
      fromCurrency: { type: String, required: true, uppercase: true },
      toCurrency: { type: String, required: true, uppercase: true },
      country: { type: String, default: null, uppercase: true },
      operator: { type: String, default: null },
    },

    result: {
      marketRate: { type: Number, default: null },
      appliedRate: { type: Number, required: true },
      fee: { type: Number, required: true },
      feeBreakdown: { type: Object, default: {} },

      grossFrom: { type: Number, required: true },
      netFrom: { type: Number, required: true },
      netTo: { type: Number, required: true },
    },

    ruleApplied: {
      ruleId: { type: mongoose.Schema.Types.ObjectId, ref: "PricingRule", required: true },
      version: { type: Number, required: true },
      priority: { type: Number, default: 0 },
    },

    // ✅ règle FX admin appliquée (si existante)
    fxRuleApplied: { type: Object, default: null },

    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

PricingQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PricingQuote", PricingQuoteSchema);
