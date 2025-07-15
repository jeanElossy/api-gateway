// models/Commission.js
const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  type:        { type: String, enum: ["cagnotte", "transaction", "retrait", "autre"], required: true },
  provider:    { type: String, default: "paynoval" }, // Ex: paynoval, mobilemoney, stripe
  country:     { type: String }, // Optionnel
  amount:      { type: Number, required: true }, // montant (fixe ou base de calcul)
  percent:     { type: Number, default: 0 }, // % (si applicable)
  minAmount:   { type: Number, default: 0 },
  maxAmount:   { type: Number, default: null },
  currency:    { type: String, default: "XOF" },
  active:      { type: Boolean, default: true },
  description: { type: String },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model("Commission", commissionSchema);
