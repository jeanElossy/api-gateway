// File: api-gateway/src/models/Transaction.js
const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // ✅ Expéditeur (owner) / initiateur (source fiable pour parrainage)
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    initiatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Legacy compat si tu as déjà des champs différents
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // 🔥 Ajout pour l'app mobile (filtrage historique / rôles)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

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

    fees: { type: Number },
    netAmount: { type: Number },

    status: {
      type: String,
      enum: ['pending', 'confirmed', 'canceled', 'failed', 'refunded'],
      default: 'pending',
    },

    toEmail: { type: String },
    toIBAN: { type: String },
    toPhone: { type: String },
    currency: { type: String },
    operator: { type: String },
    country: { type: String },

    // ✅ reference “humaine” (ex PNV-XXXX...)
    reference: { type: String },

    // ✅ providerTxId (ID provider retourné par le microservice, ex 69470dcdd9c...)
    providerTxId: { type: String, index: true },

    // 🔐 Sécurité
    requiresSecurityValidation: { type: Boolean, default: true },
    securityQuestion: { type: String },
    securityCodeHash: { type: String },
    securityAttempts: { type: Number, default: 0 },
    securityLockedUntil: { type: Date, default: null },

    confirmedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String },

    meta: { type: Object },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

// Index performant pour audit et requêtes multi-provider
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

// 🔍 Pour historique mobile par rôles
TransactionSchema.index({ createdBy: 1, createdAt: -1 });
TransactionSchema.index({ receiver: 1, createdAt: -1 });

// ✅ Recherche robuste confirm/cancel
TransactionSchema.index({ provider: 1, providerTxId: 1 });
TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
