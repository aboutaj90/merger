/**
 * محرك الدمج — ffmpeg + ffprobe داخل الدالة نفسها
 *
 * - توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *   (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p ثم concat=n=:v=1:a=1
 * - مصدر بلا صوت؟ أضف مسارًا صامتًا anullsrc بنفس مدته بدل أن يفشل الدمج
 * - الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — الناتج MP4 عالي الجودة
 * - تقدم الترميز من -progress pipe:1 (out_time_us) نسبةً إلى المدة الإجمالية
 * - ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: ensureExecutable ينسخه إلى /tmp بصلاحية 755
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { LIMITS } = require("./util");

/* ----------------------------- حل المسارات ----------------------------- */

function resolveBinary(envVar, staticModule, systemName) {
  // 1) تجاوز صريح بالبيئة
  if (process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  // 2) حزمة الثنائيات الثابتة (ffmpeg-static / ffprobe-static) — تُستخدم على Vercel
  try {
    const mod = require(staticModule);
    const p = typeof mod === "string" ? mod : mod.path || (mod.default && mod.default.path);
    if (p && fs.existsSync(p)) return p;
  } catch { /* غير مثبتة هنا */ }
  // 3) ثنائي النظام محليًا
  for (const dir of ["/usr/bin", "/usr/local/bin", "/bin"]) {
    const p = path.join(dir, systemName);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`لم يُعثر على ${systemName} — ثبّت ffmpeg-static أو اضبط ${envVar}`);
}

/** النسخ إلى /tmp بصلاحية 755 عند فقدان صلاحية التنفيذ (قيود الاستضافة) */
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `merger-${path.basename(binPath)}-${process.pid}`);
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function ffmpegPath() {
  return ensureExecutable(resolveBinary("FFMPEG_PATH", "ffmpeg-static", "ffmpeg"));
}

function ffprobePath() {
  return ensureExecutable(resolveBinary("FFPROBE_PATH", "ffprobe-static", "ffprobe"));
}

/* ------------------------------- ffprobe ------------------------------- */

function runBin(bin, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`انتهت مهلة ${path.basename(bin)}`));
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} خرج بكود ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/** فحص كل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت، الحجم */
async function probe(inputPath) {
  const out = await runBin(ffprobePath(), [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    inputPath,
  ]);
  const info = JSON.parse(out);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("لا يوجد مسار فيديو صالح في أحد المصادر");
  const fpsNum = Number(v.r_frame_rate || "0");
  const fpsDen = Number((v.r_frame_rate || "1/1").split("/")[1] || "1");
  const fps = Number.isFinite(fpsNum) && fpsDen > 0 ? fpsNum / fpsDen : 30;
  const size = info.format && info.format.size ? Number(info.format.size) : fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
  return {
    width: v.width,
    height: v.height,
    fps: Math.max(1, Math.min(120, fps || 30)),
    duration: Number(info.format && info.format.duration ? info.format.duration : v.duration || 0),
    hasAudio: Boolean(a),
    size,
  };
}

/* ---------------------------- تحقق الحدود ---------------------------- */

function even(n) {
  const x = Math.round(n);
  return x % 2 === 0 ? x : x + (x % 2 ? 1 : -1);
}

/** الهدف: أكبر دقة بين المدخلات بحد أقصى 1920×1080 وأبعاد زوجية */
function targetResolution(probes) {
  let w = 0;
  let h = 0;
  for (const p of probes) {
    w = Math.max(w, p.width || 0);
    h = Math.max(h, p.height || 0);
  }
  if (!w || !h) { w = 1280; h = 720; }
  w = Math.min(w, 1920);
  h = Math.min(h, 1080);
  return { width: even(w), height: even(h) };
}

/* ------------------------------ تنفيذ الدمج ------------------------------ */

/**
 * دمج قائمة ملفات محلية إلى ملف ناتج واحد مع تقرير التقدم:
 * onProgress(phase, progress) — phase: 'download' (0–40) تديرها طبقة الأعلى، 'encode' (40–90) هنا.
 * ترجع { size, duration, resolution }
 */
async function mergeFiles(inputPaths, outputPath, onProgress, preset) {
  const probes = [];
  for (const p of inputPaths) probes.push(await probe(p));

  // التحقق من الحدود قبل وأثناء العمل
  const totalDuration = probes.reduce((s, p) => s + (p.duration || 0), 0);
  if (totalDuration > LIMITS.maxTotalDurationSec) {
    throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد المسموح (${LIMITS.maxTotalDurationSec} ثانية)`);
  }

  const { width, height } = targetResolution(probes);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];

  // المدخلات + المسارات الصامتة للمصادر بلا صوت (بنفس مدتها)
  const chains = [];
  let inputIdx = 0;
  const silentInputs = []; // {inputIdx, duration}
  probes.forEach((p, i) => {
    args.push("-i", inputPaths[i]);
    p._inputIdx = inputIdx++;
    if (!p.hasAudio) silentInputs.push({ i, duration: Math.max(0.5, p.duration || 1) });
  });
  for (const s of silentInputs) {
    args.push("-f", "lavfi", "-t", String(s.duration.toFixed(3)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    probes[s.i]._silentIdx = inputIdx++;
  }

  // سلاسل التوحيد لكل مصدر ثم concat
  const concatInputs = [];
  probes.forEach((p, i) => {
    const vChain = `[${p._inputIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`;
    chains.push(vChain);
    const aChain = p.hasAudio
      ? `[${p._inputIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      : `[${p._silentIdx}:a]atrim=duration=${Math.max(0.5, p.duration || 1).toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
    chains.push(aChain);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  chains.push(`${concatInputs.join("")}concat=n=${probes.length}:v=1:a=1[vout][aout]`);

  args.push("-filter_complex", chains.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-c:v", "libx264", "-preset", preset || process.env.FFMPEG_PRESET || "medium", "-crf", "18");
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats");
  args.push(outputPath);

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let lastReported = 40;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("انتهت مهلة الترميز"));
    }, 280_000);

    child.stdout.on("data", (chunk) => {
      // قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية (40–90)
      const text = chunk.toString();
      const m = text.match(/out_time_us=(\d+)/);
      if (m && totalDuration > 0) {
        const seconds = Number(m[1]) / 1_000_000;
        const pct = 40 + Math.min(50, (seconds / totalDuration) * 50);
        if (pct > lastReported + 1) {
          lastReported = pct;
          try {
            onProgress && onProgress("encode", pct);
          } catch { /* ignore */ }
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg خرج بكود ${code}: ${stderr.slice(0, 400)}`));
    });
  });

  const outProbe = await probe(outputPath);
  const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (size > LIMITS.outputMaxBytes) {
    throw new Error(`حجم الناتج (${(size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${Math.round(LIMITS.outputMaxBytes / 1048576)}MB)`);
  }
  if (typeof onProgress === "function") onProgress("encode", 100);
  return {
    size,
    duration: Number(outProbe.duration.toFixed(2)),
    resolution: `${outProbe.width}x${outProbe.height}`,
  };
}

/* --------------------------- تنزيل المصادر URL --------------------------- */

/** تنزيل رابط مباشر إلى ملف مع تحقق الحجم أثناء التدفق (بمعدّل بايتات) */
async function downloadToFile(url, destPath, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`تعذر تنزيل المصدر: ${e.message}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const fs = require("fs");
  const stream = fs.createWriteStream(destPath);
  let total = 0;
  await new Promise((resolve, reject) => {
    const reader = res.body.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > LIMITS.sourceMaxBytes) {
            reader.cancel();
            reject(new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(LIMITS.sourceMaxBytes / 1048576)}MB)`));
            return;
          }
          if (!stream.write(Buffer.from(value))) {
            await new Promise((r) => stream.once("drain", r));
          }
        }
        stream.end(() => resolve());
      } catch (e) {
        reject(e);
      }
    };
    void pump();
  });
  if (total === 0) throw new Error("المصدر فارغ أو غير قابل للتنزيل");
  return total;
}

module.exports = {
  ffmpegPath,
  ffprobePath,
  probe,
  mergeFiles,
  downloadToFile,
  targetResolution,
};
