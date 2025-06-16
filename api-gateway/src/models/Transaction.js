const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider:       { type: String, required: true, enum: ['paynoval', 'stripe', 'bank', 'mobilemoney'] },
  amount:         { type: Number, required: true },
  status:         { type: String, enum: ['pending', 'confirmed', 'canceled', 'failed'], default: 'pending' },

  // Champs fréquemment utilisés pour requêtes/affichage rapides
  toEmail:        { type: String },
  toIBAN:         { type: String },
  toPhone:        { type: String },
  currency:       { type: String },
  operator:       { type: String },
  country:        { type: String },
  reference:      { type: String }, // id unique microservice

  // Snapshot complet de la requête, sans secrets
  meta:           { type: Object },

  createdAt:      { type: Date, default: Date.now },
  updatedAt:      { type: Date, default: Date.now }
});

// Index performant pour audit et requêtes multi-provider
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', TransactionSchema);
