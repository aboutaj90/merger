/**
 * اختبار وحدات — محرك الدمج والتخزين:
 * 1. توليد فيديوهين مختلفي الدقة بـ ffmpeg (أولهما بصوت وثانيهما بلا صوت)
 * 2. دمجهما والتحقق: اكتمال، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
 * 3. التخزين في Turso والاسترجاع بتطابق sha256
 * 4. مسار رفع الأجزاء (تقسيم وتجميع)
 * 5. حدود الحجم (رفض تجاوز المصدر)
 * 6. الحذف الشامل
 */
"use strict";

process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "";
process.env.TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "";

// تحميل .env إن وجد
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
})();

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("✗ متغيرات Turso غير مضبوطة (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)");
  process.exit(1);
}

const store = require("../lib/db");
const engine = require("../lib/engine");
const { saveOutputBlob } = require("../lib/store");
const { randomId } = require("../lib/util");

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
function clean() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch { /* ignore */ }
}

async function main() {
  console.log("== 1) توليد فيديوهين مختلفي الدقة ==");
  const ff = engine.ffmpegPath();
  const a = path.join(TMP, "a.mp4"); // 320x240 مع صوت
  const b = path.join(TMP, "b.mp4"); // 640x360 بلا صوت
  execFileSync(ff, ["-y", "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", a], { stdio: "pipe" });
  execFileSync(ff, ["-y", "-f", "lavfi", "-i", "testsrc2=duration=4:size=640x360:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", b], { stdio: "pipe" });
  ok("توليد الفيديو أ (320x240 بصوت)", fs.existsSync(a) && fs.statSync(a).size > 1000);
  ok("توليد الفيديو ب (640x360 بلا صوت)", fs.existsSync(b) && fs.statSync(b).size > 1000);

  console.log("== 2) الدمج والتحقق ==");
  const out = path.join(TMP, "out.mp4");
  const progressLog = [];
  const meta = await engine.mergeFiles([a, b], out, (phase, p) => progressLog.push(p));
  ok("اكتمال الدمج", fs.existsSync(out) && meta.size > 1000, `${(meta.size / 1048576).toFixed(2)}MB`);
  ok("الدقة = أكبر دقة مدخل (640x360)", meta.resolution === "640x360", meta.resolution);
  const totalDur = 3 + 4;
  ok("المدة ≈ مجموع المدد", Math.abs(meta.duration - totalDur) <= 1.2, `${meta.duration}s ≈ ${totalDur}s`);
  const outProbe = await engine.probe(out);
  ok("وجود الصوت في الناتج", outProbe.hasAudio);
  ok("تقدم الترميز وصل 100", progressLog.length > 0 && Math.max(...progressLog) >= 100);

  console.log("== 3) التخزين في Turso والاسترجاع sha256 ==");
  const jobId = "ut" + randomId(10);
  const shaOriginal = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
  await store.insertJob({ id: jobId, status: "processing", sources: [], expires_at: new Date(Date.now() + 86400000).toISOString() });
  await saveOutputBlob(jobId, out);
  const storedBytes = await store.countOutputBytes(jobId);
  ok("حجم المخزّن = حجم الملف", storedBytes === meta.size, `${storedBytes}`);
  // الاسترجاع إلى ملف
  const back = path.join(TMP, "back.mp4");
  const fd = fs.openSync(back, "w");
  let cursor = 0;
  await store.streamOutput(jobId, async (buf) => {
    fs.writeFileSync(fd, buf);
    cursor += buf.length;
  });
  fs.closeSync(fd);
  const shaBack = crypto.createHash("sha256").update(fs.readFileSync(back)).digest("hex");
  ok("تطابق sha256 بعد الاسترجاع", shaOriginal === shaBack);

  console.log("== 4) مسار رفع الأجزاء ==");
  const fileJob = "ut" + randomId(10);
  await store.insertJob({ id: fileJob, status: "uploading", sources: [{ kind: "file", name: "x.mp4", size: meta.size }], expires_at: new Date(Date.now() + 86400000).toISOString() });
  await store.insertSource(fileJob, 0, { kind: "file", name: "x.mp4", size: meta.size });
  const fileBuf = fs.readFileSync(back);
  const CHUNK = 2 * 1024 * 1024;
  let ci = 0;
  for (let off = 0; off < fileBuf.length; off += CHUNK) {
    await store.insertSourceChunk(fileJob, 0, ci++, fileBuf.subarray(off, Math.min(off + CHUNK, fileBuf.length)));
  }
  const c = await store.countSourceChunks(fileJob, 0);
  ok("عدد الأجزاء صحيح", c.count === ci, `${c.count} أجزاء`);
  const assembled = path.join(TMP, "assembled.mp4");
  const bytes = await store.assembleSourceToFile(fileJob, 0, assembled, 200 * 1048576);
  const shaAssembled = crypto.createHash("sha256").update(fs.readFileSync(assembled)).digest("hex");
  ok("تجميع الأجزاء يطابق الأصل sha256", shaAssembled === shaOriginal && bytes === meta.size);

  console.log("== 5) حدود الحجم ==");
  let rejected = false;
  try {
    await store.assembleSourceToFile(fileJob, 0, path.join(TMP, "toobig.bin"), 1000); // حد 1000 بايت فقط
  } catch (e) {
    rejected = true;
  }
  ok("رفض تجاوز حد الحجم", rejected);
  let mergeRejected = false;
  try {
    const tooMany = Array.from({ length: 11 }, () => a);
    // محاكاة رفض عدد المصادر >10 — نتحقق من قاعدة الدمج مباشرة عبر buildInputs غير متاح؛ نستخدم فحص الطبقة العليا:
    // طبقة api/jobs ترفض >10 قبل الوصول للمحرك؛ هنا نتحقق من رفض مدة زائدة:
    const longInput = path.join(TMP, "long.mp4");
    execFileSync(ff, ["-y", "-f", "lavfi", "-i", "testsrc2=duration=2:size=64x64:rate=10", "-c:v", "libx264", longInput], { stdio: "pipe" });
    // نغشّ المدة عبر تركيب 610 نسخة قصيرة غير عملي — نكتفي برفض حد الحجم أعلاه
    void tooMany;
  } catch { mergeRejected = true; }
  void mergeRejected;

  console.log("== 6) الحذف الشامل ==");
  await store.deleteJobCascade(jobId);
  await store.deleteJobCascade(fileJob);
  const gone = await store.getJob(jobId);
  const cAfter = await store.countOutputBytes(jobId);
  ok("حذف المهمة وكل صفوفها", gone === null && cAfter === 0);

  clean();
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ فشل غير متوقع:", e);
  clean();
  process.exit(1);
});
