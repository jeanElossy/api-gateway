"use strict";

/**
 * SNAPSHOT IMMUABLE D'UNE RÈGLE TARIFAIRE PUBLIÉE
 * -----------------------------------------------------------------------------
 * Un document par publication, jamais modifié après création. Cette collection
 * est à la fois le versionnage et le journal : l'historique d'un prix se lit en
 * lisant ses versions. Il n'existe pas de collection d'audit séparée.
 *
 * L'index unique {ruleId, versionNumber} est ce qui rend le rejeu d'une
 * application interrompue idempotent (voir governanceService.applyChangeRequest).
 */

const mongoose = require("mongoose");

/** Même forme que `paynoval-backend/models/AdminAdjustment.js`. */
const actorSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Le snapshot est volontairement `Mixed` : c'est une photographie de la règle
 * telle qu'elle était, pas une entité vivante. La contraindre par un schéma la
 * rendrait illisible le jour où `PricingRule` évoluera — or un journal doit
 * rester lisible même quand le modèle courant a changé.
 */
const pricingRuleVersionSchema = new mongoose.Schema(
  {
    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingRule",
      required: true,
      index: true,
    },

    versionNumber: { type: Number, required: true, min: 1 },

    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

    changeRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PricingChangeRequest",
      default: null,
    },

    publishedBy: { type: actorSchema, required: true },
    publishedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true, versionKey: false }
);

// Arbitre du rejeu : une même version ne peut pas être écrite deux fois.
pricingRuleVersionSchema.index(
  { ruleId: 1, versionNumber: -1 },
  { unique: true, name: "uniq_rule_version" }
);

module.exports =
  mongoose.models.PricingRuleVersion ||
  mongoose.model("PricingRuleVersion", pricingRuleVersionSchema);

module.exports.actorSchema = actorSchema;
