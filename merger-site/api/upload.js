/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
 * Content-Type: application/octet-stream
 */
"use strict";

const { fail, json, guard, LIMITS, readRawBody } = require("../lib/util");
const store = require("../lib/db");

async function POST(req, res) {
  const job = req.query.job;
  const seq = Number(req.query.seq);
  const chunkIdx = Number(req.query.chunk);
  if (!job || Number.isNaN(seq) || Number.isNaN(chunkIdx)) {
    return fail(res, 400, "المعاملات مطلوبة: job و seq و chunk");
  }

  const j = await store.getJob(job);
  if (!j) return fail(res, 404, "المهمة غير موجودة");
  if (j.status === "processing" || j.status === "done" || j.status === "failed") {
    return fail(res, 409, `لا يمكن الرفع في هذه الحالة (${j.status})`);
  }

  const sources = await store.getSources(job);
  const src = sources.find((s) => s.seq === seq);
  if (!src) return fail(res, 404, "المصدر غير موجود في هذه المهمة");
  if (src.kind !== "file") return fail(res, 400, "هذا المصدر رابط URL ولا يقبل رفع أجزاء");
  if (chunkIdx < 0) return fail(res, 400, "رقم الجزء غير صالح");

  const body = await readRawBody(req, LIMITS.uploadChunkBytes + 1024 * 1024);
  if (!body.ok) {
    return fail(res, 413, "حجم الجزء يتجاوز الحد المسموح (4MB) أو الجسم فارغ");
  }
  if (body.buffer.length > LIMITS.uploadChunkBytes) {
    return fail(res, 413, "حجم الجزء يتجاوز 4MB");
  }

  await store.insertSourceChunk(job, seq, chunkIdx, body.buffer);

  // تحقق الحجم التراكمي مقابل الحجم المعلن
  const c = await store.countSourceChunks(job, seq);
  if (src.size !== null && src.size > 0 && c.bytes > src.size + LIMITS.uploadChunkBytes) {
    return fail(res, 413, `الحجم المرفوع يتجاوز الحجم المعلن للملف (${Math.round(src.size / 1048576)}MB)`);
  }

  json(res, 200, { ok: true, seq, chunk: chunkIdx, receivedBytes: body.buffer.length, totalBytes: c.bytes });
}

module.exports = { POST: guard(POST) };
