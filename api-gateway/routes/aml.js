const express = require('express');
const AMLLog = require('../src/models/AMLLog');
const { requireRole } = require('../src/middlewares/authz');
const router = express.Router();

router.get('/logs', requireRole(['admin', 'superadmin']), async (req, res) => {
  const logs = await AMLLog.find().sort({ createdAt: -1 }).limit(100);
  res.json(logs);
});

module.exports = router;
