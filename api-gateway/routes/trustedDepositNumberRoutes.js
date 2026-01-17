'use strict';

const express = require('express');
const router = express.Router();

const TrustedDepositNumber = require('../models/TrustedDepositNumber');

const requireAuth = require('../middlewares/requireAuth'); // adapte

function getUserId(req) {
  return req?.user?.id || req?.user?._id || req?.auth?.userId || null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const list = await TrustedDepositNumber.find({ userId, isActive: true }).sort({ updatedAt: -1 }).lean();
    return res.json({ success: true, data: list });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || 'Erreur list trusted numbers' });
  }
});

// Optionnel : désactiver un numéro
router.patch('/:id/deactivate', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const id = req.params.id;
    const doc = await TrustedDepositNumber.findOneAndUpdate(
      { _id: id, userId },
      { $set: { isActive: false, updatedAt: new Date() } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, error: 'Introuvable' });
    return res.json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, error: e?.message || 'Erreur deactivate' });
  }
});

module.exports = router;
