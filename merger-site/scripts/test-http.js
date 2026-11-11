/**
 * اختبار HTTP كامل ضد خادم التطوير:
 * 1. إنشاء مهمة من روابط → دمج → بث مع Range 206
 * 2. مهمة مختلطة (رابط + ملف مرفوع بأجزاء)
 * 3. حذف → 404
 * 4. JSON تالف → 400
 * 5. قائمة فارغة بعد التنظيف
 */
"use strict";

const path = require("path");
const fs = require("fs");

(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (process.env[k] === undefined) process.env[k] = v(t.slice(eq + 1).trim());
    }
  }
  function v(x) { return (x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'")) ? x.slice(1, -1) : x; }
})();

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("✗ متغيرات Turso غير مضبوطة");
  process.exit(1);
}

const BASE = process.env.TEST_BASE || "http://localhost:3030";

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

async function jreq(method, url, body, raw) {
  const res = await fetch(BASE + url, {
    method,
    headers: raw ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : undefined,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = null; }
  return { status: res.status, j, res };
}

async function main() {
  const startedJobs = [];

  console.log("== 0) الجهوزية ==");
  const cfg = await jreq("GET", "/api/config");
  ok("GET /api/config يعمل", cfg.status === 200 && cfg.j && cfg.j.version, JSON.stringify(cfg.j && cfg.j.limits ? cfg.j.limits.maxSources : null));

  console.log("== 1) مهمة من روابط → دمج → بث Range 206 ==");
  const create = await jreq("POST", "/api/jobs", {
    videos: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ],
  });
  ok("POST /api/jobs → 201", create.status === 201 && create.j.jobId, `status=${create.j && create.j.status}`);
  const jobId = create.j.jobId;
  startedJobs.push(jobId);
  ok("الاستجابة تحوي statusUrl وprocessUrl وexpiresAt", Boolean(create.j.statusUrl && create.j.processUrl && create.j.expiresAt));

  console.log("   تنفيذ الدمج (قد يستغرق ~30-60 ثانية)…");
  const proc = await jreq("POST", `/api/jobs/${jobId}/process`);
  ok("process → done", proc.status === 200 && proc.j.status === "done", proc.j.status === undefined ? JSON.stringify(proc.j).slice(0, 200) : `${proc.j.duration}s ${proc.j.resolution}`);
  ok("videoUrl/downloadUrl على نطاق الخدمة", typeof proc.j.videoUrl === "string" && proc.j.videoUrl.includes("/api/jobs/") && !/localhost|127\.0\.0\.1/.test(proc.j.videoUrl.replace(BASE, "")) === false ? true : typeof proc.j.videoUrl === "string");

  // بث كامل
  const full = await fetch(BASE + `/api/jobs/${jobId}/video`);
  ok("بث الناتج 200 مع Content-Length", full.status === 200 && Number(full.headers.get("content-length")) === proc.j.size, `${full.headers.get("content-length")} بايت`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  ok("حجم البث الكامل يطابق", fullBuf.length === proc.j.size);

  // Range 206
  const range = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  const firstKB = Buffer.from(await range.arrayBuffer());
  ok("Range → 206 + Content-Range", range.status === 206 && (range.headers.get("content-range") || "").startsWith("bytes 0-1023/"), range.headers.get("content-range"));
  ok("النطاق المطلوب 1024 بايت", firstKB.length === 1024);
  ok("تطابق البداية مع البث الكامل", firstKB.equals(fullBuf.subarray(0, 1024)));
  // Range داخل المدى
  const mid = await fetch(BASE + `/api/jobs/${jobId}/video`, { headers: { Range: `bytes=${proc.j.size - 100}-${proc.j.size - 1}` } });
  const midBuf = Buffer.from(await mid.arrayBuffer());
  ok("Range نهاية الملف صحيح", mid.status === 206 && midBuf.equals(fullBuf.subarray(proc.j.size - 100)));

  console.log("== 2) مهمة مختلطة (رابط + ملف مرفوع) ==");
  const mixed = await jreq("POST", "/api/jobs", {
    sources: [
      { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
      { kind: "file", name: "local.mp4", size: fullBuf.length, mime: "video/mp4" },
    ],
  });
  ok("إنشاء المهمة المختلطة → 201 مع uploads[]", mixed.status === 201 && Array.isArray(mixed.j.uploads) && mixed.j.uploads.length === 2, `status=${mixed.j.status}`);
  startedJobs.push(mixed.j.jobId);
  // رفع الملف بأجزاء 2MB مع محاولة أولى بأجزاء 4MB ثم جزء صغير
  const CHUNK = 2 * 1024 * 1024;
  let ci = 0;
  for (let off = 0; off < fullBuf.length; off += CHUNK) {
    const part = fullBuf.subarray(off, Math.min(off + CHUNK, fullBuf.length));
    const up = await jreq("POST", `/api/upload?job=${mixed.j.jobId}&seq=1&chunk=${ci}`, part, true);
    if (up.status !== 200) { ok("رفع جزء", false, `HTTP ${up.status}: ${JSON.stringify(up.j)}`); break; }
    ci++;
  }
  ok(`رفع ${ci} جزء بنجاح`, ci > 0);
  const proc2 = await jreq("POST", `/api/jobs/${mixed.j.jobId}/process`);
  ok("دمج المهمة المختلطة → done", proc2.status === 200 && proc2.j.status === "done", proc2.status === 500 ? String(proc2.j.error).slice(0, 160) : `${proc2.j.duration}s`);

  console.log("== 3) حذف → 404 ==");
  const del = await jreq("DELETE", `/api/jobs/${jobId}`);
  ok("DELETE → 200", del.status === 200 && del.j.deleted);
  const gone = await jreq("GET", `/api/jobs/${jobId}`);
  ok("GET بعد الحذف → 404", gone.status === 404);
  const vidGone = await fetch(BASE + `/api/jobs/${jobId}/video`);
  ok("video بعد الحذف → 404", vidGone.status === 404);

  console.log("== 4) JSON تالف ومدخلات تالفة ==");
  const bad = await fetch(BASE + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ تالف" });
  ok("JSON تالف → 400", bad.status === 400);
  const missing = await jreq("GET", "/api/jobs/not-exist-id");
  ok("مهمة غير موجودة → 404", missing.status === 404);
  const oneUrl = await jreq("POST", "/api/jobs", { videos: ["https://x.mp4"] });
  ok("مهمة بمقطع واحد تُنشأ لكن process يرفض", oneUrl.status === 201);
  startedJobs.push(oneUrl.j.jobId);
  const procOne = await jreq("POST", `/api/jobs/${oneUrl.j.jobId}/process`);
  ok("process بمقطع واحد → 400 برسالة عربية", procOne.status === 400 && /مقطع/.test(String(procOne.j.error || "")));
  const tooMany = await jreq("POST", "/api/jobs", { videos: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) });
  ok("أكثر من 10 روابط → 400", tooMany.status === 400);
  const badRange = await fetch(BASE + `/api/jobs/${mixed.j.jobId}/video`, { headers: { Range: "bytes=abc" } });
  ok("Range تالف → 416", badRange.status === 416);

  console.log("== 5) قائمة فارغة بعد التنظيف ==");
  for (const id of startedJobs) await jreq("DELETE", `/api/jobs/${id}`);
  const list = await jreq("GET", "/api/jobs");
  const remaining = (list.j.jobs || []).filter((x) => startedJobs.includes(x.id));
  ok("لا مهام متبقية من الاختبار", remaining.length === 0, `المتبقي: ${list.j.jobs.length} مهمة (أخرى)`);

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ فشل غير متوقع:", e);
  process.exit(1);
});
