"use strict";

const FxRule = require("../src/models/FxRule");

exports.list = async (req, res) => {
  try {
    const q = {};
    ["active", "provider", "country", "fromCurrency", "toCurrency", "mode", "txType"].forEach((k) => {
      if (req.query[k] !== undefined && req.query[k] !== "") q[k] = req.query[k];
    });

    const limit = parseInt(req.query.limit, 10) || 100;
    const skip = parseInt(req.query.skip, 10) || 0;

    const [data, total] = await Promise.all([
      FxRule.find(q).sort({ priority: -1, updatedAt: -1 }).skip(skip).limit(limit),
      FxRule.countDocuments(q),
    ]);

    res.json({ success: true, data, total });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const doc = await FxRule.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "FxRule introuvable" });
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};

exports.create = async (req, res) => {
  try {
    const doc = new FxRule(req.body);
    await doc.save();
    res.status(201).json({ success: true, data: doc });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const doc = await FxRule.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ success: false, message: "FxRule introuvable" });
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const doc = await FxRule.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: "FxRule introuvable" });
    res.json({ success: true, message: "FxRule supprimée" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
};
