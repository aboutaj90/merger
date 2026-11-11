/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن):
 * سحب المصادر (0–40) ← ترميز (40–90) ← تخزين الناتج (→100) وإرجاع رابط الفيديو النهائي.
 * لو المهمة قيد المعالجة فعله يرجع 202.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { json, fail, guard, LIMITS, tmpCleanup, publicBase } = require("../../../lib/util");
const store = require("../../../lib/db");
const { saveOutputBlob } = require("../../../lib/store");
const engine = require("../../../lib/engine");

async function POST(req, res) {
  // تنظيف كسول
  void store.deleteExpiredJobs().catch(() => {});

  const id = req.query.id;
  if (!id) return fail(res, 400, "معرّف المهمة مطلوب");

  const job = await store.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  if (job.status === "processing") {
    return json(res, 202, { status: "processing", jobId: id, progress: job.progress });
  }
  if (job.status === "done") {
    const base = publicBase(req);
    return json(res, 200, {
      status: "done",
      videoUrl: job.result ? job.result.videoUrl || `${base}/api/jobs/${id}/video` : `${base}/api/jobs/${id}/video`,
      downloadUrl: job.result && job.result.downloadUrl ? job.result.downloadUrl : `${base}/api/jobs/${id}/video?download=1`,
      size: job.result ? job.result.size : undefined,
      duration: job.result ? job.result.duration : undefined,
      resolution: job.result ? job.result.resolution : undefined,
      expiresAt: job.expires_at,
    });
  }
  if (job.status === "failed") {
    return fail(res, 409, `المهمة فاشلة سابقًا: ${job.error || "سبب غير معروف"} — أنشئ مهمة جديدة`);
  }
  if (job.status === "uploading") {
    // تأكد أن المصادر المرفوعة اكتملت (كل مصدر file له أجزاء)
    const sources0 = await store.getSources(id);
    for (const s of sources0) {
      if (s.kind === "file") {
        const c = await store.countSourceChunks(id, s.seq);
        if (c.count === 0) {
          return fail(res, 409, "الملفات لم تُرفع بالكامل بعد — أكمل رفع الأجزاء ثم أعد المحاولة");
        }
      }
    }
  }

  const sources = await store.getSources(id);
  if (sources.length < 2) {
    await store.updateJob(id, { status: "failed", error: "الدمج يحتاج مقطعَين على الأقل" });
    return fail(res, 400, "الدمج يحتاج مقطعَين على الأقل");
  }

  await store.updateJob(id, { status: "processing", progress: 0, error: null });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merger-"));
  const inputPaths = [];
  const cleanup = [];
  try {
    // 0–40: سحب المصادر (تنزيل الروابط أو تجميع الأجزاء المرفوعة من Turso)
    const step = 40 / sources.length;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (s.kind === "url") {
        await engine.downloadToFile(s.url, dest);
      } else {
        const bytes = await store.assembleSourceToFile(id, s.seq, dest, LIMITS.sourceMaxBytes);
        if (bytes === 0) throw new Error(`المصدر المرفوع رقم ${s.seq} فارغ`);
      }
      inputPaths.push(dest);
      cleanup.push(dest);
      await store.updateJob(id, { progress: Math.round((i + 1) * step) });
    }

    // 40–90: ترميز ffmpeg (التقدم يقرأ من -progress pipe:1)
    const outPath = path.join(tmpDir, "output.mp4");
    cleanup.push(outPath);
    const meta = await engine.mergeFiles(inputPaths, outPath, async (phase, progress) => {
      await store.updateJob(id, { progress: Math.round(progress) });
    });

    // →100: تخزين الناتج في Turso كصفوف 2MB ثم حذف أجزاء المصادر
    await store.updateJob(id, { progress: 90 });
    await saveOutputBlob(id, outPath);
    await store.deleteSourceChunks(id);

    const base = publicBase(req);
    const result = {
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: meta.size,
      duration: meta.duration,
      resolution: meta.resolution,
    };
    await store.updateJob(id, { status: "done", progress: 100, result_json: JSON.stringify(result), error: null });
    json(res, 200, { status: "done", ...result, expiresAt: job.expires_at });
  } catch (e) {
    // تجاوز أي حد = فشل واضح برسالة وليس انهيارًا
    const msg = e && e.message ? e.message : "خطأ غير معروف أثناء الدمج";
    await store.updateJob(id, { status: "failed", error: msg }).catch(() => {});
    fail(res, 500, msg);
  } finally {
    // لا نظام ملفات دائم — نظّف /tmp في finally
    tmpCleanup(cleanup);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

module.exports = { POST: guard(POST) };
