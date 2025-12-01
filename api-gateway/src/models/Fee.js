// // src/models/Fee.js
// const mongoose = require('mongoose');

// const feeSchema = new mongoose.Schema({
//   name:        { type: String, required: true },
//   slug:        { type: String, trim: true, lowercase: true, index: true }, // clé technique unique (ex: 'paynoval-xof-1pct')
//   description: { type: String },
//   provider:    { type: String }, // Pour filtrer par opérateur/banque/etc
//   country:     { type: String }, // Pour filtrer par pays
//   currency:    { type: String, default: 'XOF' },
//   type:        { type: String, enum: ['fixed', 'percent'], default: 'fixed' }, // type de frais: fixe ou pourcentage
//   amount:      { type: Number, required: true }, // valeur du barème (montant fixe OU pourcentage)
//   minFee:      { type: Number }, // (optionnel) montant minimum de frais (si type percent)
//   maxFee:      { type: Number }, // (optionnel) montant maximum de frais (si type percent)
//   minAmount:   { type: Number }, // (optionnel) borne min du montant sur lequel ce barème s’applique
//   maxAmount:   { type: Number }, // (optionnel) borne max du montant
//   active:      { type: Boolean, default: true },
//   lastUsedAt:  { type: Date }, // pour reporting/fonctionnalités admin
//   createdAt:   { type: Date, default: Date.now },
//   updatedAt:   { type: Date, default: Date.now }
// });

// // Index combiné pour accélérer les recherches/filtres
// feeSchema.index({ 
//   slug: 1,
//   provider: 1, 
//   country: 1, 
//   currency: 1, 
//   type: 1, 
//   active: 1, 
//   minAmount: 1, 
//   maxAmount: 1 
// });

// // Toujours mettre à jour updatedAt
// feeSchema.pre('save', function (next) {
//   this.updatedAt = Date.now();
//   // Auto-slug si non fourni (ex : provider-country-currency-type-amount)
//   if (!this.slug && this.provider && this.currency && this.type) {
//     this.slug = [
//       this.provider,
//       this.country,
//       this.currency,
//       this.type,
//       String(this.amount)
//     ].join('-').replace(/\s+/g, '-').toLowerCase();
//   }
//   next();
// });

// module.exports = mongoose.model('Fee', feeSchema);



// src/models/Fee.js

const mongoose = require('mongoose');

const feeSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  slug:        { type: String, trim: true, lowercase: true, index: true }, // clé technique unique (ex: 'paynoval-xof-1pct')
  description: { type: String },
  provider:    { type: String }, // Pour filtrer par opérateur/banque/etc
  country:     { type: String }, // Pour filtrer par pays
  currency:    { type: String, default: 'XOF' },
  type:        { type: String, enum: ['fixed', 'percent'], default: 'fixed' }, // type de frais: fixe ou pourcentage
  amount:      { type: Number, required: true }, // valeur du barème (montant fixe OU pourcentage)
  minFee:      { type: Number }, // (optionnel) montant minimum de frais (si type percent)
  maxFee:      { type: Number }, // (optionnel) montant maximum de frais (si type percent)
  minAmount:   { type: Number }, // (optionnel) borne min du montant sur lequel ce barème s’applique
  maxAmount:   { type: Number }, // (optionnel) borne max du montant
  active:      { type: Boolean, default: true },
  lastUsedAt:  { type: Date }, // pour reporting/fonctionnalités admin
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

// Index combiné pour accélérer les recherches/filtres
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

// Toujours mettre à jour updatedAt
feeSchema.pre('save', function (next) {
  this.updatedAt = Date.now();

  // Auto-slug si non fourni (ex : provider-country-currency-type-amount)
  if (!this.slug && this.provider && this.currency && this.type) {
    this.slug = [
      this.provider,
      this.country,
      this.currency,
      this.type,
      String(this.amount),
    ]
      .join('-')
      .replace(/\s+/g, '-')
      .toLowerCase();
  }

  next();
});

feeSchema.pre('findOneAndUpdate', function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

module.exports = mongoose.model('Fee', feeSchema);
