'use strict';

const mongoose = require('mongoose');

const PhoneVerificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  purpose: {
    type: String,
    enum: ['trusted_deposit_number'],
    default: 'trusted_deposit_number',
    index: true,
  },

  phoneE164: { type: String, required: true },
  phoneDigits: { type: String, required: true, index: true },

  channel: { type: String, enum: ['sms', 'whatsapp', 'call', 'email'], default: 'sms' },

  // Twilio Verify info (optionnel)
  verificationSid: { type: String },
  status: { type: String, enum: ['pending', 'verified', 'expired'], default: 'pending', index: true },

  // Anti-spam simple (cooldown)
  lastSentAt: { type: Date, default: null },
  sendCount: { type: Number, default: 0 },

  // Expiration locale (même si Twilio gère déjà)
  expiresAt: { type: Date, required: true, index: true },

  verifiedAt: { type: Date, default: null },

  meta: { type: Object },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// TTL (auto-clean)
PhoneVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

PhoneVerificationSchema.index({ userId: 1, purpose: 1, phoneDigits: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PhoneVerification', PhoneVerificationSchema);
