// File: src/models/PricingQuote.js
"use strict";

const mongoose = require("mongoose");

const PricingQuoteSchema = new mongoose.Schema(
  {
    quoteId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "USED", "EXPIRED"],
      default: "ACTIVE",
      index: true,
    },

    request: {
      txType: { type: String, required: true, uppercase: true },
      method: { type: String, default: null, uppercase: true },

      amount: { type: Number, required: true, min: 0 },

      fromCurrency: { type: String, required: true, uppercase: true },
      toCurrency: { type: String, required: true, uppercase: true },

      country: { type: String, default: null, uppercase: true },
      fromCountry: { type: String, default: null, uppercase: true },
      toCountry: { type: String, default: null, uppercase: true },

      operator: { type: String, default: null, lowercase: true },
      provider: { type: String, default: null, lowercase: true },
    },

    result: {
      marketRate: { type: Number, default: null },
      appliedRate: { type: Number, required: true },

      fee: { type: Number, required: true, default: 0 },
      feeBreakdown: { type: Object, default: {} },

      grossFrom: { type: Number, required: true },
      netFrom: { type: Number, required: true },
      netTo: { type: Number, required: true },
    },

    ruleApplied: {
      ruleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PricingRule",
        required: true,
      },
      version: { type: Number, required: true, default: 1 },
      priority: { type: Number, default: 0 },
    },

    fxRuleApplied: {
      type: Object,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// TTL: expire automatiquement quand expiresAt est dépassé
PricingQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.PricingQuote ||
  mongoose.model("PricingQuote", PricingQuoteSchema);