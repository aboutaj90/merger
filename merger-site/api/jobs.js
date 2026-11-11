/**
 * POST /api/jobs  — إنشاء مهمة دمج (روابط أو ملفات ستُرفع)
 * GET  /api/jobs  — قائمة المهام الأخيرة
 *
 * يقبل {"videos":["رابط1","رابط2"]} أو
 * {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * → 201 {"jobId","status","statusUrl","processUrl","expiresAt","uploads"?}
 */
"use strict";

const { LIMITS, json, fail, readJsonBody, randomId, newExpiresAt, guard, publicBase } = require("../lib/util");
const store = require("../lib/db");

async function POST(req, res) {
  // تنظيف كسول للمهام المنتهية عند كل طلب إنشاء
  void store.deleteExpiredJobs().catch(() => {});

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(res, 400, "جسم الطلب تالف: JSON غير صالح");

  const body = parsed.body || {};
  let sources = [];

  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) => ({
      kind: s && s.kind === "file" ? "file" : "url",
      url: s && s.url ? String(s.url).trim() : null,
      name: s && s.name ? String(s.name).slice(0, 200) : null,
      mime: s && s.mime ? String(s.mime).slice(0, 100) : null,
      size: s && s.size !== undefined && s.size !== null ? Number(s.size) : null,
    }));
  } else {
    return fail(res, 400, 'الجسم يجب أن يحتوي "videos" (مصفوفة روابط) أو "sources" (مصفوفة مصادر)');
  }

  // التحقق الصارم قبل أي تخزين
  if (!sources.length) return fail(res, 400, "أضف مقطعًا واحدًا على الأقل لإنشاء المهمة");
  if (sources.length > LIMITS.maxSources) {
    return fail(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);
  }
  for (const s of sources) {
    if (s.kind === "url") {
      if (!/^https?:\/\//i.test(s.url || "")) {
        return fail(res, 400, "كل الروابط يجب أن تكون http/https مباشرة وعامة");
      }
    } else {
      if (s.size !== null && s.size > LIMITS.sourceMaxBytes) {
        return fail(res, 413, `حجم الملف ${s.name || ""} يتجاوز الحد المسموح (${Math.round(LIMITS.sourceMaxBytes / 1048576)}MB)`);
      }
    }
  }

  const id = randomId();
  const expiresAt = newExpiresAt();
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";

  await store.insertJob({ id, status, sources, expires_at: expiresAt });
  for (let i = 0; i < sources.length; i++) {
    await store.insertSource(id, i, sources[i]);
  }

  const base = publicBase(req);
  const reply = {
    jobId: id,
    status,
    statusUrl: `${base}/api/jobs/${id}`,
    processUrl: `${base}/api/jobs/${id}/process`,
    expiresAt: expiresAt,
  };
  if (hasFiles) {
    reply.uploads = sources.map((s, i) =>
      s.kind === "file"
        ? {
            seq: i,
            name: s.name,
            uploadUrl: `${base}/api/upload?job=${id}&seq=${i}&chunk={chunk}`,
            uploadChunkBytes: LIMITS.uploadChunkBytes,
          }
        : { seq: i, name: null }
    );
    reply.uploadChunkBytes = LIMITS.uploadChunkBytes;
  }
  json(res, 201, reply);
}

async function GET(req, res) {
  const jobs = await store.listJobs(20);
  json(res, 200, { jobs });
}

module.exports = { POST: guard(POST), GET: guard(GET) };
