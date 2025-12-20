// File: api-gateway/src/models/Transaction.js
"use strict";

const mongoose = require("mongoose");

const { Schema } = mongoose;

const TransactionSchema = new Schema(
  {
    // ✅ Legacy (présent dans tes docs)
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // ✅ IMPORTANT : expéditeur / initiateur (pour parrainage + historique)
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    initiatorUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    // 🔥 Ajout pour l'app mobile (filtrage historique / rôles)
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },

    // receiver peut être ObjectId OU email/texte selon provider
    receiver: { type: Schema.Types.Mixed, default: null, index: true },

    recipientUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    provider: {
      type: String,
      required: true,
      enum: [
        "paynoval",
        "stripe",
        "bank",
        "mobilemoney",
        "visa_direct",
        "cashin",
        "cashout",
        "stripe2momo",
        "flutterwave",
      ],
      index: true,
    },

    amount: { type: Number, required: true },

    // 💸 Frais et netAmount (optionnels)
    fees: { type: Number },
    netAmount: { type: Number },

    status: {
      type: String,
      enum: ["pending", "confirmed", "canceled", "failed", "refunded"],
      default: "pending",
      index: true,
    },

    toEmail: { type: String, index: true },
    toIBAN: { type: String },
    toPhone: { type: String },
    currency: { type: String },
    operator: { type: String },
    country: { type: String, index: true },
    reference: { type: String, index: true },

    // 🔐 Sécurité PayNoval
    requiresSecurityValidation: { type: Boolean, default: true },
    securityQuestion: { type: String },
    securityCodeHash: { type: String },
    securityAttempts: { type: Number, default: 0 },
    securityLockedUntil: { type: Date, default: null },

    confirmedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String },

    // Snapshot complet de la requête, sans secrets
    meta: { type: Schema.Types.Mixed, default: {} },

    // ✅ pour garder les infos recipient (comme ton exemple)
    recipientInfo: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

// Index performant pour audit et requêtes multi-provider
TransactionSchema.index({ provider: 1, status: 1, createdAt: -1 });
TransactionSchema.index({ userId: 1, provider: 1, reference: 1 });

// Pour historique mobile par rôles
TransactionSchema.index({ createdBy: 1, createdAt: -1 });
TransactionSchema.index({ receiver: 1, createdAt: -1 });

// Unicité "souple" sur (provider, reference) pour éviter les doublons
TransactionSchema.index({ provider: 1, reference: 1 }, { sparse: true });

module.exports = mongoose.models.Transaction || mongoose.model("Transaction", TransactionSchema);
