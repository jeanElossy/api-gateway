"use strict";

const express = require("express");
const router = express.Router();
const config = require("../src/config");
const requireAdmin = require("../src/middlewares/requireAdmin");
const ctrl = require("../controllers/fxRulesController");

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

router.get("/", ctrl.list);
router.get("/:id", ctrl.getById);
router.post("/", ctrl.create);
router.put("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

module.exports = router;
