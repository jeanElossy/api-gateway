// File: api-gateway/src/models/Transaction.js
'use strict';

const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // ✅ IMPORTANT: expéditeur réel (owner/initiator)
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  initiatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

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

  // 💸 Frais et netAmount (optionnels)
  fees: { type: Number },
  netAmount: { type: Number },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'canceled', 'failed', 'refunded'],
    default: 'pending',
  },

  // Champs fréquemment utilisés
  toEmail: { type: String },
  toIBAN: { type: String },
  toPhone: { type: String },
  currency: { type: String },
  operator: { type: String },
  country: { type: String },

  // ✅ Référence "humaine" (PNV-xxxx) ou fallback
  reference: { type: String },

  // ✅ ID provider (Mongo id provider, etc.)
  providerTxId: { type: String },

  // 🔐 Sécurité
  requiresSecurityValidation: { type: Boolean, default: true },
  securityQuestion: { type: String },
  securityCodeHash: { type: String },
  securityAttempts: { type: Number, default: 0 },
  securityLockedUntil: { type: Date, default: null },

  // Historisation
  confirmedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelReason: { type: String },

  meta: { type: Object },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Index performants
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

// ✅ match rapide confirm/cancel via providerTxId
TransactionSchema.index({ provider: 1, providerTxId: 1 }, { sparse: true });

// 🔍 Pour historique mobile par rôles
TransactionSchema.index({ createdBy: 1, createdAt: -1 });
TransactionSchema.index({ receiver: 1, createdAt: -1 });

// Unicité "souple" sur (provider, reference)
TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
