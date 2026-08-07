"use strict";

/**
 * MIGRATION — LIGNE DE BASE DU JOURNAL TARIFAIRE
 * -----------------------------------------------------------------------------
 * Donne `currentVersion: 1` aux règles qui n'en ont pas et leur crée une
 * PricingRuleVersion n°1 à partir de leur état courant, pour que le journal
 * démarre sur une ligne de base plutôt que dans le vide.
 *
 * IDEMPOTENT : relançable sans effet de bord. Les règles déjà versionnées et
 * les snapshots déjà écrits sont ignorés.
 *
 * Usage :  node scripts/migratePricingVersions.js [--dry-run]
 */

require("dotenv").config();
const mongoose = require("mongoose");

const PricingRule = require("../src/models/PricingRule");
const PricingRuleVersion = require("../src/models/PricingRuleVersion");
const { buildSnapshot } = require("../src/services/pricing/governanceService");

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Acteur conventionnel de la reprise. `staffId` est requis par le schéma :
 * on utilise un ObjectId nul, qui ne correspond à aucun compte et se lit
 * comme « reprise automatique » dans le journal.
 */
const MIGRATION_ACTOR = {
  staffId: new mongoose.Types.ObjectId("000000000000000000000000"),
  email: "",
  name: "Reprise automatique (migration)",
  at: new Date(),
};

async function main() {
  const uri = process.env.MONGO_URI_GATEWAY;

  if (!uri) {
    console.error("MONGO_URI_GATEWAY absent : impossible de migrer.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connecté${DRY_RUN ? " (simulation, aucune écriture)" : ""}.`);

  const rules = await PricingRule.find({}).lean();
  console.log(`${rules.length} règle(s) trouvée(s).`);

  let versionsSet = 0;
  let snapshotsCreated = 0;
  let skipped = 0;

  for (const rule of rules) {
    const hasVersion =
      Number.isFinite(Number(rule.currentVersion)) && Number(rule.currentVersion) >= 1;
    const targetVersion = hasVersion ? Number(rule.currentVersion) : 1;

    if (!hasVersion) {
      if (!DRY_RUN) {
        await PricingRule.updateOne({ _id: rule._id }, { $set: { currentVersion: 1 } });
      }
      versionsSet += 1;
    }

    const existing = await PricingRuleVersion.findOne({
      ruleId: rule._id,
      versionNumber: targetVersion,
    }).lean();

    if (existing) {
      skipped += 1;
      continue;
    }

    if (!DRY_RUN) {
      await PricingRuleVersion.create({
        ruleId: rule._id,
        versionNumber: targetVersion,
        snapshot: buildSnapshot(rule),
        changeRequestId: null,
        publishedBy: MIGRATION_ACTOR,
        // La date de dernière modification de la règle est la meilleure
        // approximation disponible : n'inventons pas un horodatage.
        publishedAt: rule.updatedAt || rule.createdAt || new Date(),
      });
    }

    snapshotsCreated += 1;
  }

  console.log(`currentVersion posé sur   : ${versionsSet}`);
  console.log(`snapshots créés           : ${snapshotsCreated}`);
  console.log(`déjà à jour, ignorés      : ${skipped}`);

  await mongoose.disconnect();
  console.log("Terminé.");
}

main().catch(async (err) => {
  console.error("Échec de la migration :", err);
  try {
    await mongoose.disconnect();
  } catch {
    // La déconnexion peut échouer si la connexion n'a jamais abouti.
  }
  process.exit(1);
});
