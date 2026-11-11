/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range) ليعمل التقديم/الترجيع،
 * و ?download=1 للتحميل. يقرأ صفوف Blobs من Turso تدفقيًا بصفحات من 8 صفوف مع تقليم
 * أول/آخر جزء حسب المدى المطلوب.
 */
"use strict";

const { fail, guard, LIMITS } = require("../../../lib/util");
const store = require("../../../lib/db");

async function GET(req, res) {
  const id = req.query.id;
  if (!id) return fail(res, 400, "معرّف المهمة مطلوب");

  const job = await store.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.status !== "done") {
    return fail(res, 409, `الناتج غير جاهز بعد — الحالة: ${job.status}`);
  }

  const total = await store.countOutputBytes(id);
  if (total === 0) return fail(res, 404, "لا يوجد ناتج مخزن لهذه المهمة");

  // تحليل ترويسة Range
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total - 1;
  let partial = false;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (!m[1] && !m[2])) return fail(res, 416, "مدى Range غير صالح");
    if (m[1] === "") {
      // suffix range: آخر N بايت
      const suffix = Number(m[2]);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
    if (start > end || start >= total) return fail(res, 416, "المدى المطلوب خارج حدود الملف");
    partial = true;
  }

  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  };
  if (req.query.download === "1") {
    const safeName = `merged-${id}.mp4`;
    headers["Content-Disposition"] = `attachment; filename="${safeName}"`;
  }
  res.writeHead(partial ? 206 : 200, partial ? { ...headers, "Content-Range": `bytes ${start}-${end}/${total}` } : headers);

  // بث الصفوف من Turso مع تقليم أول/آخر جزء حسب المدى
  const pageRows = LIMITS.readPageRows;
  let offset = 0;
  let cursor = 0; // أول بايت غير مُرسل بعد
  try {
    for (;;) {
      const r = await store.db().execute({
        sql: `SELECT chunk_idx, data FROM output_chunks WHERE job_id = ? ORDER BY chunk_idx ASC LIMIT ? OFFSET ?`,
        args: [id, String(pageRows), String(offset)],
      });
      if (!r.rows.length) break;
      for (const row of r.rows) {
        const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        const chunkStart = cursor;
        const chunkEnd = cursor + buf.length - 1;
        cursor = chunkEnd + 1;
        if (chunkEnd < start || chunkStart > end) continue; // خارج المدى
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd = Math.min(buf.length - 1, end - chunkStart);
        const piece = buf.subarray(sliceStart, sliceEnd + 1);
        if (!res.write(piece)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      if (r.rows.length < pageRows) break;
      offset += pageRows;
    }
    res.end();
  } catch (e) {
    // انقطاع العميل أثناء البث أمر طبيعي — لا حاجة لرسالة خطأ هنا
    try {
      res.end();
    } catch { /* ignore */ }
  }
}

module.exports = { GET: guard(GET) };
