/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
 */
"use strict";

const { json, guard, LIMITS } = require("../lib/util");
const store = require("../lib/db");

async function GET(req, res) {
  // التأكد من جاهزية قاعدة البيانات أيضًا
  let database = "turso-connected";
  try {
    await store.ensureSchema();
    await store.db().execute("SELECT 1");
  } catch {
    database = "disconnected";
  }
  json(res, 200, {
    version: LIMITS.version,
    database,
    limits: {
      maxSources: LIMITS.maxSources,
      sourceMaxMB: Math.round(LIMITS.sourceMaxBytes / 1048576),
      outputMaxMB: Math.round(LIMITS.outputMaxBytes / 1048576),
      maxTotalDurationSec: LIMITS.maxTotalDurationSec,
      uploadChunkBytes: LIMITS.uploadChunkBytes,
      retentionHours: LIMITS.retentionHours,
    },
  });
}

module.exports = { GET: guard(GET) };
