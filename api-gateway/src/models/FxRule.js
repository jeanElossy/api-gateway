"use strict";

const mongoose = require("mongoose");

const fxRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    active: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 0, index: true },

    // Scope (tous optionnels sauf devises)
    txType: { type: String, default: "", trim: true, uppercase: true }, // TRANSFER/DEPOSIT/WITHDRAW (optionnel)
    provider: { type: String, default: "", trim: true, lowercase: true }, // optionnel
    country: { type: String, default: "", trim: true, lowercase: true },  // optionnel

    fromCurrency: { type: String, required: true, uppercase: true, index: true },
    toCurrency: { type: String, required: true, uppercase: true, index: true },

    minAmount: { type: Number, default: 0 },
    maxAmount: { type: Number, default: null },

    mode: {
      type: String,
      enum: ["PASS_THROUGH", "OVERRIDE", "DELTA_PERCENT", "DELTA_ABS"],
      default: "PASS_THROUGH",
    },

    overrideRate: { type: Number, default: null }, // si OVERRIDE
    percent: { type: Number, default: 0 },         // si DELTA_PERCENT (peut être négatif)
    deltaAbs: { type: Number, default: 0 },        // si DELTA_ABS (peut être négatif)

    lastUsedAt: { type: Date, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

fxRuleSchema.index({
  active: 1,
  fromCurrency: 1,
  toCurrency: 1,
  priority: -1,
  updatedAt: -1,
});

module.exports = mongoose.model("FxRule", fxRuleSchema);
