"use strict";

const mongoose = require("mongoose");
const PricingRule = require("../src/models/PricingRule");

function toBool(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

function toNum(v, defaultValue = undefined) {
  if (v === undefined || v === null || v === "") return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

function cleanString(v, fallback = undefined) {
  if (v === undefined) return fallback;
  if (v === null) return null;
  return String(v).trim();
}

function toDateOrNull(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeArray(arr, transform = (x) => x) {
  if (!Array.isArray(arr)) return [];
  return arr.map(transform).filter(Boolean);
}

function normalizeScopeUpperAll(v, fallback = "ALL") {
  const s = cleanString(v, fallback);
  if (!s) return fallback;
  if (String(s).trim().toLowerCase() === "all") return "ALL";
  return String(s).trim().toUpperCase();
}

function normalizeScopeLowerAll(v, fallback = "all") {
  const s = cleanString(v, fallback);
  if (!s) return fallback;
  if (String(s).trim().toLowerCase() === "all") return "all";
  return String(s).trim().toLowerCase();
}

function pickPayload(body = {}) {
  const scopeIn = body.scope || {};

  return {
    name: cleanString(body.name),
    code: cleanString(body.code),
    description: cleanString(body.description, ""),
    notes: cleanString(body.notes, ""),
    active: toBool(body.active, true),
    priority: toNum(body.priority, 0),
    category: cleanString(body.category, "pricing"),
    service: normalizeScopeLowerAll(body.service, "all"),

    scope: {
      txType: normalizeScopeUpperAll(scopeIn.txType || body.txType, "ALL"),
      method: normalizeScopeUpperAll(scopeIn.method || body.method, "ALL"),
      provider: normalizeScopeLowerAll(scopeIn.provider || body.provider, "all"),
      country: normalizeScopeUpperAll(scopeIn.country || body.country, "ALL"),
      fromCountry: normalizeScopeUpperAll(scopeIn.fromCountry || body.fromCountry, "ALL"),
      toCountry: normalizeScopeUpperAll(scopeIn.toCountry || body.toCountry, "ALL"),
      fromCurrency: normalizeScopeUpperAll(scopeIn.fromCurrency || body.fromCurrency),
      toCurrency: normalizeScopeUpperAll(scopeIn.toCurrency || body.toCurrency),
    },

    countries: normalizeArray(body.countries, (x) => String(x).trim().toUpperCase()),
    operators: normalizeArray(body.operators, (x) => String(x).trim().toLowerCase()),

    amountRange: {
      min: toNum(body.amountRange?.min ?? body.minAmount, 0),
      max:
        body.amountRange?.max === null || body.maxAmount === null
          ? null
          : toNum(body.amountRange?.max ?? body.maxAmount, null),
    },

    fee: {
      mode: normalizeScopeUpperAll(body.fee?.mode || body.feeMode, "NONE"),
      fixed: toNum(body.fee?.fixed ?? body.feeFixed, 0),
      percent: toNum(body.fee?.percent ?? body.feePercent, 0),
      minFee:
        body.fee?.minFee === null || body.feeMinFee === null
          ? null
          : toNum(body.fee?.minFee ?? body.feeMinFee, null),
      maxFee:
        body.fee?.maxFee === null || body.feeMaxFee === null
          ? null
          : toNum(body.fee?.maxFee ?? body.feeMaxFee, null),
    },

    fx: {
      mode: normalizeScopeUpperAll(body.fx?.mode || body.fxMode, "PASS_THROUGH"),
      overrideRate:
        body.fx?.overrideRate === null || body.fxOverrideRate === null
          ? null
          : toNum(body.fx?.overrideRate ?? body.fxOverrideRate, null),
      markupPercent: toNum(body.fx?.markupPercent ?? body.fxMarkupPercent, 0),
      percent: toNum(body.fx?.percent ?? body.fxPercent, 0),
      deltaAbs: toNum(body.fx?.deltaAbs ?? body.fxDeltaAbs, 0),
      notes: cleanString(body.fx?.notes || body.fxNotes, ""),
    },

    startsAt: toDateOrNull(body.startsAt),
    endsAt: toDateOrNull(body.endsAt),
    version: toNum(body.version, 1),

    metadata:
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {},
  };
}

function removeUndefined(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = removeUndefined(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

exports.listPricingRules = async (req, res) => {
  try {
    const {
      q,
      active,
      txType,
      method,
      provider,
      country,
      fromCountry,
      toCountry,
      fromCurrency,
      toCurrency,
      feeMode,
      fxMode,
      page = 1,
      limit = 50,
      sortBy = "priority",
      sortOrder = "desc",
    } = req.query;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const skip = (safePage - 1) * safeLimit;

    const filter = {};

    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim(), "i");
      filter.$or = [
        { name: regex },
        { code: regex },
        { description: regex },
        { notes: regex },
        { "scope.provider": regex },
        { "fx.notes": regex },
      ];
    }

    const parsedActive = toBool(active, undefined);
    if (parsedActive !== undefined) filter.active = parsedActive;

    if (txType) filter["scope.txType"] = String(txType).trim().toUpperCase();
    if (method) filter["scope.method"] = String(method).trim().toUpperCase();
    if (provider) filter["scope.provider"] = String(provider).trim().toLowerCase();
    if (country) filter["scope.country"] = String(country).trim().toUpperCase();
    if (fromCountry) filter["scope.fromCountry"] = String(fromCountry).trim().toUpperCase();
    if (toCountry) filter["scope.toCountry"] = String(toCountry).trim().toUpperCase();
    if (fromCurrency) filter["scope.fromCurrency"] = String(fromCurrency).trim().toUpperCase();
    if (toCurrency) filter["scope.toCurrency"] = String(toCurrency).trim().toUpperCase();
    if (feeMode) filter["fee.mode"] = String(feeMode).trim().toUpperCase();
    if (fxMode) filter["fx.mode"] = String(fxMode).trim().toUpperCase();

    const allowedSortFields = new Set(["createdAt", "updatedAt", "name", "priority", "active"]);
    const sortField = allowedSortFields.has(String(sortBy)) ? String(sortBy) : "priority";
    const sortDir = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;

    const [items, total] = await Promise.all([
      PricingRule.find(filter)
        .sort({ [sortField]: sortDir, updatedAt: -1, _id: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      PricingRule.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: items,
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("[pricingRules.list] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération des règles de pricing",
      error: error.message,
    });
  }
};

exports.getPricingRuleById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID invalide",
      });
    }

    const item = await PricingRule.findById(id).lean();

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Règle introuvable",
      });
    }

    return res.status(200).json({
      success: true,
      data: item,
    });
  } catch (error) {
    console.error("[pricingRules.getById] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la récupération de la règle",
      error: error.message,
    });
  }
};

exports.createPricingRule = async (req, res) => {
  try {
    const payload = removeUndefined(pickPayload(req.body));

    if (!payload.name) {
      return res.status(400).json({
        success: false,
        message: "Le champ 'name' est obligatoire",
      });
    }

    if (!payload.scope?.fromCurrency || !payload.scope?.toCurrency) {
      return res.status(400).json({
        success: false,
        message: "scope.fromCurrency et scope.toCurrency sont obligatoires",
      });
    }

    const doc = new PricingRule({
      ...payload,
      createdBy: req.user?._id || null,
      updatedBy: req.user?._id || null,
    });

    await doc.save();

    return res.status(201).json({
      success: true,
      message: "Règle créée avec succès",
      data: doc,
    });
  } catch (error) {
    console.error("[pricingRules.create] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la création de la règle",
      error: error.message,
    });
  }
};

exports.updatePricingRule = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID invalide",
      });
    }

    const payload = removeUndefined(pickPayload(req.body));
    payload.updatedBy = req.user?._id || null;

    const updated = await PricingRule.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Règle introuvable",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Règle mise à jour avec succès",
      data: updated,
    });
  } catch (error) {
    console.error("[pricingRules.update] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la mise à jour de la règle",
      error: error.message,
    });
  }
};

exports.deletePricingRule = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "ID invalide",
      });
    }

    const deleted = await PricingRule.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Règle introuvable",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Règle supprimée avec succès",
      data: { _id: deleted._id },
    });
  } catch (error) {
    console.error("[pricingRules.delete] error:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la suppression de la règle",
      error: error.message,
    });
  }
};