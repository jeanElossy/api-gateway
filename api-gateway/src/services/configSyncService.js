"use strict";

const axios = require("axios");
const LRU = require("lru-cache");
const pino = require("pino");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const feeCache = new LRU({
  max: 1000,
  ttl: 1000 * 60 * 5, // 5 minutes
});

const fxCache = new LRU({
  max: 200,
  ttl: 1000 * 60 * 5,
});

const CONFIG_BASE_URL = process.env.CONFIG_SERVICE_URL;

const headers = () => ({
  "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN,
});

async function syncFees() {
  const { data } = await axios.get(
    `${CONFIG_BASE_URL}/internal/config/fees`,
    { headers: headers() }
  );

  feeCache.set("ALL", data);
  logger.info({ count: data.length }, "Fees synced");
}

async function syncFxRates() {
  const { data } = await axios.get(
    `${CONFIG_BASE_URL}/internal/config/fx`,
    { headers: headers() }
  );

  fxCache.set("ALL", data);
  logger.info({ count: data.length }, "FX synced");
}

async function warmUpConfigs() {
  await Promise.all([syncFees(), syncFxRates()]);
}

module.exports = {
  warmUpConfigs,
  feeCache,
  fxCache,
};
