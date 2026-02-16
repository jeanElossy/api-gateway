
"use strict";

const express = require("express");
const router = express.Router();

const config = require("../src/config");
const requireAdmin = require("../src/middlewares/requireAdmin");
const feesCtrl = require("../controllers/feesController");

router.get("/simulate", feesCtrl.simulateFee);

const requireInternalOrAdmin = (req, res, next) => {
  const internalHeader = req.get("x-internal-token");
  const expectedInternal =
    process.env.GATEWAY_INTERNAL_TOKEN ||
    process.env.INTERNAL_TOKEN ||
    config.internalToken ||
    "";

  if (internalHeader && expectedInternal && internalHeader === expectedInternal) return next();
  return requireAdmin(req, res, next);
};

router.use(requireInternalOrAdmin);

router.get("/", feesCtrl.getFees);
router.get("/:id", feesCtrl.getFeeById);
router.post("/", feesCtrl.createFee);
router.put("/:id", feesCtrl.updateFee);
router.delete("/:id", feesCtrl.deleteFee);

module.exports = router;
