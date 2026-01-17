// src/models/ExchangeRate.js
const mongoose = require("mongoose");

const exchangeRateSchema = new mongoose.Schema(
  {
    from: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 3,
      maxlength: 4,
      trim: true,
    },
    to: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 3,
      maxlength: 4,
      trim: true,
    },
    rate: { type: Number, required: true, min: 0.00001, max: 9999 },

    /**
     * ✅ kind permet d’avoir :
     * - custom (admin)
     * - snapshot (dernier taux connu utilisé en fallback quand quota/429)
     *
     * Compat: tes anciens documents n'ont pas ce champ => default "custom".
     */
    kind: {
      type: String,
      enum: ["custom", "snapshot"],
      default: "custom",
      index: true,
    },

    /**
     * ✅ active = seulement pour les custom
     * - custom actif = le taux admin en cours
     * - custom inactif = historique
     * - snapshot = on le laisse généralement active:false
     */
    active: { type: Boolean, default: true, index: true },

    // email admin (custom)
    updatedBy: { type: String, trim: true, default: null },

    // ✅ metadata snapshot (facultatif)
    provider: { type: String, trim: true, default: null }, // ex: "principal" / "exchangerate-api"
    source: { type: String, trim: true, default: null }, // ex: "backend:fx" / "external:exchangerate-api"
    asOfDate: { type: String, trim: true, default: null },
    stale: { type: Boolean, default: false },
  },
  {
    timestamps: true, // ✅ ajoute createdAt + updatedAt automatiquement
  }
);

/**
 * ✅ IMPORTANT: index "un seul taux actif" MAIS uniquement pour custom+active:true
 * => permet d'avoir plusieurs inactifs (historique) sans conflit.
 */
exchangeRateSchema.index(
  { from: 1, to: 1, kind: 1, active: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "custom", active: true },
  }
);

/**
 * ✅ Un seul snapshot par pair (from,to)
 */
exchangeRateSchema.index(
  { from: 1, to: 1, kind: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "snapshot" },
  }
);

module.exports = mongoose.model("ExchangeRate", exchangeRateSchema);
