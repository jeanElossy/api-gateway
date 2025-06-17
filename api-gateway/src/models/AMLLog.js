// src/models/AMLLog.js
const mongoose = require('mongoose');

const AMLLogSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:          { type: String, enum: ['initiate', 'confirm', 'cancel'], required: true },
  provider:      { type: String, required: true },
  amount:        { type: Number, required: true },
  toEmail:       { type: String },
  details:       { type: Object },
  flagged:       { type: Boolean, default: false },
  flagReason:    { type: String, default: '' },
  reviewed:      { type: Boolean, default: false },
  reviewedBy:    { type: String },
  reviewComment: { type: String },
  createdAt:     { type: Date, default: Date.now }
});

module.exports = mongoose.model('AMLLog', AMLLogSchema);
