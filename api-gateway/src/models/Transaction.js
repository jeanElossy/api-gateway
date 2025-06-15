const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  provider:       { type: String, required: true },
  amount:         { type: Number, required: true },
  toEmail:        { type: String },
  toIBAN:         { type: String },
  toPhone:        { type: String },
  status:         { type: String, enum: ['pending', 'confirmed', 'canceled', 'failed'], default: 'pending' },
  meta:           { type: Object }, // toute autre info (devise, pays, etc.)
  createdAt:      { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', TransactionSchema);
