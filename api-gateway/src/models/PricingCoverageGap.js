"use strict";

/**
 * CORRIDOR DEMANDÉ SANS RÈGLE APPLICABLE — CONSTATÉ, JAMAIS SUPPOSÉ
 * -----------------------------------------------------------------------------
 * On n'invente aucune matrice théorique de corridors « attendus » : on
 * enregistre les échecs réels du moteur. Chaque ligne est un fait — ce
 * périmètre a été demandé, N fois, et aucune règle ne le couvrait.
 */

const mongoose = require("mongoose");

const pricingCoverageGapSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },

    /** La requête normalisée, telle que le moteur l'a reçue. */
    request: { type: mongoose.Schema.Types.Mixed, required: true },

    occurrences: { type: Number, default: 1, min: 1 },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },

    /** Posé quand une règle couvrant ce périmètre est publiée. */
    resolvedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, versionKey: false }
);

pricingCoverageGapSchema.index({ resolvedAt: 1, lastSeenAt: -1 });

module.exports =
  mongoose.models.PricingCoverageGap ||
  mongoose.model("PricingCoverageGap", pricingCoverageGapSchema);
