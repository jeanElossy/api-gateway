// src/models/ExchangeRate.js
const mongoose = require("mongoose");

const exchangeRateSchema = new mongoose.Schema(
  {
    from: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },
    to: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },

    rate: { type: Number, required: true, min: 0.00001, max: 999999 },

    // ✅ admin custom rate = active:true
    // ✅ snapshot fallback = active:false
    active: { type: Boolean, default: true },

    updatedBy: { type: String, trim: true, default: null }, // email admin

    // ✅ champs snapshot (optionnels)
    source: { type: String, trim: true, default: null },     // "snapshot" | "db-custom" | "backend:fx" | ...
    provider: { type: String, trim: true, default: null },   // "principal" | "exchangerate-api" | ...
    asOfDate: { type: Date, default: null },
    stale: { type: Boolean, default: false },
  },
  {
    timestamps: true, // ✅ createdAt / updatedAt auto
  }
);

// ✅ Unicité: un seul taux actif (ou snapshot) par pair
exchangeRateSchema.index({ from: 1, to: 1, active: 1 }, { unique: true, name: "uniq_from_to_active" });

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);
