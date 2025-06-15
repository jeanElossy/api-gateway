// routes/aml.js
const express = require('express');
const AMLLog = require('../src/models/AMLLog');
const router = express.Router();

// (Optionnel: ajoute un middleware adminAuth ici)
router.get('/logs', async (req, res) => {
  const logs = await AMLLog.find().sort({ createdAt: -1 }).limit(100);
  res.json(logs);
});

module.exports = router;
