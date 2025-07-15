const express = require("express");
const router = express.Router();
const ExchangeRate = require("../models/ExchangeRate");
const requireAdmin = require("../middleware/requireAdmin");
const ctrl = require("../controllers/exchangeRatesController");

// Endpoint public SANS auth, pour le mobile
router.get('/rate', ctrl.getRatePublic);

// Toutes les routes suivantes sont réservées admin !
router.use(requireAdmin);

// Liste (admin)
router.get("/", async (req, res) => {
  try {
    const filter = {};
    if (req.query.from) filter.from = req.query.from.toUpperCase();
    if (req.query.to) filter.to = req.query.to.toUpperCase();
    if (req.query.active !== undefined) filter.active = req.query.active === "true";
    const rates = await ExchangeRate.find(filter).sort({ updatedAt: -1 });
    res.json({ success: true, data: rates });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Erreur serveur." });
  }
});

// Création (admin)
router.post("/", async (req, res) => {
  try {
    const rate = await ExchangeRate.create(req.body);
    res.json({ success: true, data: rate });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Update (admin)
router.put("/:id", async (req, res) => {
  try {
    const rate = await ExchangeRate.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!rate) return res.status(404).json({ success: false, message: "Taux introuvable" });
    res.json({ success: true, data: rate });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Delete (admin)
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await ExchangeRate.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: "Taux introuvable" });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

module.exports = router;
