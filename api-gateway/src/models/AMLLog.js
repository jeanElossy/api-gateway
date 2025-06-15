const mongoose = require('mongoose');

const AMLLogSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:          { type: String, enum: ['initiate', 'confirm', 'cancel'], required: true },
  provider:      { type: String, required: true },
  amount:        { type: Number, required: true },
  toEmail:       { type: String },
  details:       { type: Object }, // snapshot de la req
  flagged:       { type: Boolean, default: false },
  flagReason:    { type: String, default: '' },
  reviewed:      { type: Boolean, default: false },
  reviewedBy:    { type: String },    // email/adminId de l'analyste
  reviewComment: { type: String },    // note manuelle compliance
  createdAt:     { type: Date, default: Date.now }
});

module.exports = mongoose.model('AMLLog', AMLLogSchema);
