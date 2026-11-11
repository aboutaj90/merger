/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
 *
 * العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18.
 * القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
 * كل الملفات تُحذف تلقائيًا بعد 24 ساعة.
 */
import { ProviderError, type ProviderKey } from "./providers/types";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/+$/, "");

export const MERGER_LIMITS = {
  maxVideos: 10,
  maxSourceMB: 200,
  maxOutputMB: 150,
  maxTotalDurationSec: 600,
};

const TIMEOUT_MS = 60_000; // عملية process متزامنة تستغرق ~10-15 ثانية — مهلة سخية

interface MergerResponse {
  status?: number;
  ok: boolean;
  body: Record<string, unknown> | null;
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<MergerResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e: unknown) {
    // أخطاء شبكتنا نحن (timeout/fetch) = مؤقّتة — مميّزة بحالة 0
    throw new ProviderError(0, `merger network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/* ------------------------- تحليل الحالة (دفاعي) ------------------------- */

const DONE_STATES = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAIL_STATES = /^(error|failed|failure|cancelled|canceled)$/i;

export interface MergerStatus {
  state: "processing" | "completed" | "failed";
  progress: number;
  videoUrl?: string;
  error?: string;
}

/** تحليل رد GET /api/jobs/{id} — يدعم progress كنسبة 0..1 أو 0..100، وerror بلا status */
export function parseMergerStatus(body: Record<string, unknown> | null, jobId: string): MergerStatus {
  if (!body) {
    // جسم غير قابل للتحليل: عاملها فشلًا حتميًا (المواصفة: قد يرد الجسم فيه error بلا status)
    return { state: "failed", progress: 0, error: `استجابة غير صالحة من خدمة الدمج للمهمة ${jobId}` };
  }
  let error = typeof body.error === "string" ? body.error : undefined;
  const rawStatus = typeof body.status === "string" ? body.status : error ? "failed" : "";

  let progress = typeof body.progress === "number" ? body.progress : 0;
  if (progress > 0 && progress <= 1) progress = progress * 100; // يأتي أحيانًا كسرًا 0..1
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الفيديو المباشر
  const videoUrl =
    (typeof body.videoUrl === "string" && body.videoUrl.startsWith("http") ? body.videoUrl : undefined) ??
    (typeof body.downloadUrl === "string" && body.downloadUrl.startsWith("http") ? body.downloadUrl : undefined) ??
    `${MERGER_BASE}/api/jobs/${jobId}/video`;

  if (error && !rawStatus) return { state: "failed", progress, error };
  if (DONE_STATES.test(rawStatus)) return { state: "completed", progress: 100, videoUrl };
  if (FAIL_STATES.test(rawStatus) || (error && !DONE_STATES.test(rawStatus)))
    return { state: "failed", progress, error: error ?? "فشلت مهمة الدمج" };
  return { state: "processing", progress, videoUrl };
}

/* ----------------------------- واجهة العميل ----------------------------- */

/** إنشاء مهمة دمج — POST /api/jobs {"videos":[...]} → {"jobId","status","statusUrl","processUrl","expiresAt"} */
export async function mergerCreateJob(videos: string[]): Promise<{ jobId: string; expiresAt?: string }> {
  const r = await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos }),
  });
  // أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
  const err = r.body?.error ? String(r.body.error) : `HTTP ${r.status}`;
  if (!r.ok || !r.body?.jobId) throw new ProviderError(r.status || 500, `merger: ${err}`);
  return { jobId: String(r.body.jobId), expiresAt: r.body.expiresAt ? String(r.body.expiresAt) : undefined };
}

/** تنفيذ الدمج — POST /api/jobs/{id}/process (متزامن ~10-15 ثانية) */
export async function mergerProcess(jobId: string): Promise<MergerStatus> {
  const r = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
  if (r.status === 202) return { state: "processing", progress: 50 }; // قيد المعالجة بالفعل
  const err = r.body?.error ? String(r.body.error) : `HTTP ${r.status}`;
  if (!r.ok) throw new ProviderError(r.status || 500, `merger: ${err}`);
  return parseMergerStatus(r.body, jobId);
}

/** استعلام حالة — GET /api/jobs/{id}. 404 = المهمة حذفت/انتهت صلاحيتها */
export async function mergerGetJob(jobId: string): Promise<MergerStatus> {
  const r = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, undefined, 15_000);
  if (r.status === 404) {
    return { state: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (r.status === 0) throw new ProviderError(0, "merger network error (استعلام الحالة)"); // مؤقت
  if (!r.ok) {
    // خطأ HTTP معلن = فشل نهائي فوري
    const err = r.body?.error ? String(r.body.error) : `HTTP ${r.status}`;
    return { state: "failed", progress: 0, error: err };
  }
  return parseMergerStatus(r.body, jobId);
}

/** فحص الجهوزية — GET /api/config بمهلة 4 ثوانٍ (يستخدمه /api/health) */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const r = await mergerFetch("/api/config", undefined, 4_000);
    return r.ok;
  } catch {
    return false;
  }
}

/** حذف فوري (تنظيف) — DELETE /api/jobs/{id} */
export async function mergerDeleteJob(jobId: string): Promise<void> {
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10_000);
  } catch {
    // التنظيف اختياري — نتجاهل الأخطاء
  }
}

/** تصدير النوع للاستخدام في المنسّق */
export type { ProviderKey };
