/**
 * GET    /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */
"use strict";

const { json, fail, guard, publicBase } = require("../../lib/util");
const store = require("../../lib/db");

async function GET(req, res) {
  const id = req.query.id;
  if (!id) return fail(res, 400, "معرّف المهمة مطلوب");
  const job = await store.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

  const base = publicBase(req);
  const reply = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    sources: job.sources.map((s) => ({ kind: s.kind, name: s.name, url: s.url, size: s.size })),
    expiresAt: job.expires_at,
    createdAt: job.created_at,
  };
  if (job.error) reply.error = job.error;
  if (job.status === "done" && job.result) {
    reply.videoUrl = job.result.videoUrl || `${base}/api/jobs/${id}/video`;
    reply.downloadUrl = job.result.downloadUrl || `${base}/api/jobs/${id}/video?download=1`;
    reply.size = job.result.size;
    reply.duration = job.result.duration;
    reply.resolution = job.result.resolution;
  }
  json(res, 200, reply);
}

async function DELETE(req, res) {
  const id = req.query.id;
  if (!id) return fail(res, 400, "معرّف المهمة مطلوب");
  const job = await store.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة");
  await store.deleteJobCascade(id);
  json(res, 200, { deleted: true, jobId: id });
}

module.exports = { GET: guard(GET), DELETE: guard(DELETE) };
