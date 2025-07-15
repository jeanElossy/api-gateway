// src/models/ExchangeRate.js
const mongoose = require('mongoose');

const exchangeRateSchema = new mongoose.Schema({
  from:    { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },
  to:      { type: String, required: true, uppercase: true, minlength: 3, maxlength: 4, trim: true },
  rate:    { type: Number, required: true, min: 0.00001, max: 9999 },
  active:  { type: Boolean, default: true },
  updatedBy: { type: String, trim: true, default: null }, // email admin
  updatedAt: { type: Date, default: Date.now }
});

// Unicité par devise, un seul taux actif à la fois pour chaque pair
exchangeRateSchema.index({ from: 1, to: 1, active: 1 }, { unique: true });

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);
