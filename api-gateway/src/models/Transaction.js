const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  provider: {
    type: String,
    required: true,
    enum: [
      'paynoval',
      'stripe',
      'bank',
      'mobilemoney',
      'visa_direct',
      'cashin',
      'cashout',
      'stripe2momo',
      'flutterwave',
    ],
  },

  amount: { type: Number, required: true },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'canceled', 'failed', 'refunded'],
    default: 'pending',
  },

  // Champs fréquemment utilisés pour requêtes/affichage rapides
  toEmail: { type: String },
  toIBAN: { type: String },
  toPhone: { type: String },
  currency: { type: String },
  operator: { type: String },
  country: { type: String },
  reference: { type: String }, // id unique microservice

  // 🔐 Sécurité PayNoval (commune à tous les providers)
  requiresSecurityValidation: { type: Boolean, default: true },
  securityQuestion: { type: String },
  securityCodeHash: { type: String },
  securityAttempts: { type: Number, default: 0 },
  securityLockedUntil: { type: Date, default: null },

  // Historisation
  confirmedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelReason: { type: String },

  // Snapshot complet de la requête, sans secrets (pas de carte brute, pas de cvc)
  meta: { type: Object },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Index performant pour audit et requêtes multi-provider
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

module.exports = mongoose.model('Transaction', TransactionSchema);
