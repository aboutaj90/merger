/**
 * GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json)
 */
"use strict";

const { json, guard } = require("../lib/util");
const store = require("../lib/db");

async function GET(req, res) {
  const deleted = await store.deleteExpiredJobs();
  json(res, 200, { ok: true, deletedJobs: deleted });
}

module.exports = { GET: guard(GET) };
