// // File: api-gateway/src/models/Transaction.js
// 'use strict';

// const mongoose = require('mongoose');

// const TransactionSchema = new mongoose.Schema({
//   userId: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//     required: true,
//   },

//   ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
//   initiatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

//   createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
//   receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

//   provider: {
//     type: String,
//     required: true,
//     enum: [
//       'paynoval',
//       'stripe',
//       'bank',
//       'mobilemoney',
//       'visa_direct',
//       'cashin',
//       'cashout',
//       'stripe2momo',
//       'flutterwave',
//     ],
//   },

//   amount: { type: Number, required: true },

//   fees: { type: Number },
//   netAmount: { type: Number },

//   status: {
//     type: String,
//     enum: ['pending', 'confirmed', 'canceled', 'failed', 'refunded'],
//     default: 'pending',
//   },

//   toEmail: { type: String },
//   toIBAN: { type: String },
//   toPhone: { type: String },
//   currency: { type: String },
//   operator: { type: String },
//   country: { type: String },

//   reference: { type: String },
//   providerTxId: { type: String },

//   requiresSecurityValidation: { type: Boolean, default: true },
//   securityQuestion: { type: String },
//   securityCodeHash: { type: String },
//   securityAttempts: { type: Number, default: 0 },
//   securityLockedUntil: { type: Date, default: null },

//   confirmedAt: { type: Date },
//   cancelledAt: { type: Date },
//   cancelReason: { type: String },

//   meta: { type: Object },

//   createdAt: { type: Date, default: Date.now },
//   updatedAt: { type: Date, default: Date.now },
// });

// // Index performants
// TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
// TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

// // ✅ match rapide confirm/cancel via providerTxId
// TransactionSchema.index({ provider: 1, providerTxId: 1 }, { sparse: true });

// // ✅ utile pour retrouver rapidement “l’expéditeur” réel
// TransactionSchema.index({ ownerUserId: 1, createdAt: -1 }, { sparse: true });
// TransactionSchema.index({ initiatorUserId: 1, createdAt: -1 }, { sparse: true });

// // 🔍 Pour historique mobile par rôles
// TransactionSchema.index({ createdBy: 1, createdAt: -1 });
// TransactionSchema.index({ receiver: 1, createdAt: -1 });

// // Unicité "souple" sur (provider, reference)
// TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });

// module.exports = mongoose.model('Transaction', TransactionSchema);




// File: api-gateway/src/models/Transaction.js
'use strict';

const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // ✅ rôles (important pour historique / referral)
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  initiatorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

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

  // ✅ FLOW (ajout)
  action: {
    type: String,
    enum: ['deposit', 'withdraw', 'send'],
    default: 'send',
  },
  funds: { type: String },        // ex: 'paynoval', 'stripe', 'mobilemoney'
  destination: { type: String },  // ex: 'bank', 'mobilemoney', 'paynoval'
  providerSelected: { type: String }, // provider routé réel (celui utilisé)

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

  reference: { type: String },
  providerTxId: { type: String },

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
});

// ✅ updatedAt automatique
TransactionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});
TransactionSchema.pre('findOneAndUpdate', function (next) {
  this.set({ updatedAt: new Date() });
  next();
});

// Index performants
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

// ✅ match rapide confirm/cancel via providerTxId
TransactionSchema.index({ provider: 1, providerTxId: 1 }, { sparse: true });

// ✅ utile pour retrouver rapidement “l’expéditeur” réel
TransactionSchema.index({ ownerUserId: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ initiatorUserId: 1, createdAt: -1 }, { sparse: true });

// 🔍 Pour historique mobile par rôles
TransactionSchema.index({ createdBy: 1, createdAt: -1 });
TransactionSchema.index({ receiver: 1, createdAt: -1 });

// Unicité "souple" sur (provider, reference)
TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });

// ✅ Flow debug
TransactionSchema.index({ providerSelected: 1, createdAt: -1 }, { sparse: true });
TransactionSchema.index({ action: 1, createdAt: -1 }, { sparse: true });

module.exports = mongoose.model('Transaction', TransactionSchema);




