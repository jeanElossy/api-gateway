// src/models/userModel.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email:     { type: String, unique: true, required: true },
  kycLevel:  { type: Number, default: 0 },
  kybStatus: { type: String, default: 'en_attente' },
  type:      { type: String, enum: ['individual', 'business'], default: 'individual' },
  // ...ajoute tous les champs dont tu as besoin côté API
}, { timestamps: true });

/**
 * Factory qui retourne le modèle User attaché à la connexion passée en paramètre
 */
module.exports = (conn) => {
  // Pour éviter un "OverwriteModelError", on vérifie si le modèle existe déjà sur la connexion
  return conn.models.User || conn.model('User', userSchema);
};
