// // File: src/routes/pricingRulesRoutes.js
// "use strict";

// const express = require("express");
// const router = express.Router();

// const {
//   listPricingRules,
//   getPricingRuleById,
//   createPricingRule,
//   updatePricingRule,
//   deletePricingRule,
// } = require("../controllers/pricingRulesController");

// const { protect } = require("../src/middlewares/auth");
// const { requireRole } = require("../src/middlewares/authz");

// router.get("/", protect, requireRole(["admin", "superadmin"]), listPricingRules);
// router.post("/", protect, requireRole(["admin", "superadmin"]), createPricingRule);

// router.get("/:id", protect, requireRole(["admin", "superadmin"]), getPricingRuleById);
// router.put("/:id", protect, requireRole(["admin", "superadmin"]), updatePricingRule);
// router.patch("/:id", protect, requireRole(["admin", "superadmin"]), updatePricingRule);
// router.delete("/:id", protect, requireRole(["admin", "superadmin"]), deletePricingRule);

// module.exports = router;




"use strict";

const express = require("express");
const router = express.Router();

const {
  listPricingRules,
  getPricingRuleById,
  createPricingRule,
  updatePricingRule,
  deletePricingRule,
} = require("../controllers/pricingRulesController");

const authMod = require("../src/middlewares/auth");
const { requireRole } = require("../src/middlewares/authz");

/**
 * ✅ Compat protect/authMiddleware
 */
const authMiddleware = authMod.authMiddleware || authMod.protect || authMod;

router.get("/", authMiddleware, requireRole(["admin", "superadmin"]), listPricingRules);
router.post("/", authMiddleware, requireRole(["admin", "superadmin"]), createPricingRule);

router.get("/:id", authMiddleware, requireRole(["admin", "superadmin"]), getPricingRuleById);
router.put("/:id", authMiddleware, requireRole(["admin", "superadmin"]), updatePricingRule);
router.patch("/:id", authMiddleware, requireRole(["admin", "superadmin"]), updatePricingRule);
router.delete("/:id", authMiddleware, requireRole(["admin", "superadmin"]), deletePricingRule);

module.exports = router;