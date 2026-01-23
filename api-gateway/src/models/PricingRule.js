"use strict";

const mongoose = require("mongoose");

const AmountRangeSchema = new mongoose.Schema(
  {
    min: { type: Number, default: 0 },
    max: { type: Number, default: null }, // null = no max
  },
  { _id: false }
);

const FeeSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["NONE", "PERCENT", "FIXED", "MIXED"],
      default: "NONE",
    },
    percent: { type: Number, default: 0 }, // ex 1.5
    fixed: { type: Number, default: 0 }, // montant en fromCurrency
    minFee: { type: Number, default: null },
    maxFee: { type: Number, default: null },
  },
  { _id: false }
);

const FxSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      enum: ["MARKET", "OVERRIDE", "MARKUP"],
      default: "MARKET",
    },
    overrideRate: { type: Number, default: null }, // ex 650.12
    markupPercent: { type: Number, default: 0 }, // ex +1.2%
  },
  { _id: false }
);

const PricingRuleSchema = new mongoose.Schema(
  {
    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0, index: true },

    scope: {
      txType: {
        type: String,
        enum: ["TRANSFER", "DEPOSIT", "WITHDRAW"],
        required: true,
        index: true,
      },
      fromCurrency: { type: String, required: true, uppercase: true, index: true },
      toCurrency: { type: String, required: true, uppercase: true, index: true },

      // optionnels
      countries: [{ type: String, uppercase: true }], // ex ["CI","SN"]
      operators: [{ type: String }], // ex ["ORANGE","MTN","WAVE"]
    },

    amountRange: { type: AmountRangeSchema, default: () => ({ min: 0, max: null }) },

    fee: { type: FeeSchema, default: () => ({ mode: "NONE" }) },
    fx: { type: FxSchema, default: () => ({ mode: "MARKET" }) },

    version: { type: Number, default: 1 },

    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Index utile pour la recherche de règles
PricingRuleSchema.index({
  active: 1,
  "scope.txType": 1,
  "scope.fromCurrency": 1,
  "scope.toCurrency": 1,
  priority: -1,
  updatedAt: -1,
});

module.exports = mongoose.model("PricingRule", PricingRuleSchema);
