"use strict";

/**
 * - GET /transactions/insights is relayed (declared before `/:id`).
 * - A successful write drops the user's cached list pages (read-your-own-writes).
 * - The initiate success log never contains the response body (rule B.4).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  listTxCache,
  listTxInflight,
  buildListTxCacheKey,
  invalidateUserListCache,
} = require("../../src/services/transactions/listCache");

test("invalidates only the given user's pages", () => {
  const mine = buildListTxCacheKey({ userId: "u1", provider: "txcore", query: { skip: 0 } });
  const other = buildListTxCacheKey({ userId: "u2", provider: "txcore", query: { skip: 0 } });
  listTxCache.set(mine, { body: {} });
  listTxCache.set(other, { body: {} });
  listTxInflight.set(mine, Promise.resolve());

  assert.equal(invalidateUserListCache("u1"), 2);
  assert.equal(listTxCache.has(mine), false);
  assert.equal(listTxCache.has(other), true);
  assert.equal(invalidateUserListCache(""), 0);
});

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");

test("insights route is declared before /:id", () => {
  const routes = read("routes/transactions.js");
  assert.ok(routes.indexOf('"/insights"') > -1);
  assert.ok(routes.indexOf('"/insights"') < routes.indexOf('router.get("/:id"'));
});

test("writes invalidate the cache; the initiate log carries no body", () => {
  const controller = read("controllers/transactionsController.js");
  assert.equal((controller.match(/afterWrite\(req, out\);/g) || []).length, 3);
  assert.doesNotMatch(controller, /initiateTransaction\] success",\s*\{[^}]*\bbody:\s*out\?\.body/);
});
