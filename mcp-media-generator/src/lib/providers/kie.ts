/**
 * مزود kie.ai — Jobs API الموحد (الأشكال حقيقية مقاسة بنداءات فعلية):
 *
 * POST https://api.kie.ai/api/v1/jobs/createTask
 *   Authorization: Bearer <key>
 *   {"model":"<providerModel>","input":{...}}
 *   → {"code":200,"msg":"success","data":{"taskId":"...","recordId":"..."}}
 *
 * GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>
 *   → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
 *        "resultJson":"{\"resultUrls\":[\"https://...\"]}",   // نص JSON داخل JSON
 *        "failMsg":...}}
 */
import { ProviderError, PROVIDER_TIMEOUT_MS, type ProviderAdapter, type ProviderKey } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

interface KieResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

async function kieFetch<T>(key: string, path: string, init?: RequestInit): Promise<KieResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (e: unknown) {
    // انقطاع شبكة/مهلة — مؤقت
    throw new ProviderError(503, `temporary network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let body: KieResponse<T> & { msg?: string } | null = null;
  try {
    body = (await res.json()) as KieResponse<T>;
  } catch {
    body = null;
  }

  // أخطاء HTTP مع اهتمام خاص: نفاد الرصيد قد يأتي بحالة 400 مع رسالة insufficient/balance
  if (!res.ok || (body && typeof body.code === "number" && body.code >= 400)) {
    const msg = body?.msg || body?.data?.toString() || `kie.ai HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  if (body && typeof body.code === "number" && body.code !== 200) {
    throw new ProviderError(res.status, String(body.msg ?? `kie.ai code ${body.code}`));
  }
  if (!body) throw new ProviderError(res.status || 500, `kie.ai غير متوقع: استجابة بلا جسم JSON`);
  return body;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>) {
    const r = await kieFetch<{ taskId?: string; recordId?: string }>(key.api_key, "/createTask", {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const taskId = r.data?.taskId ?? r.data?.recordId;
    if (!taskId) throw new ProviderError(502, `kie.ai لم يعرد taskId`);
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const r = await kieFetch<{
      state?: string;
      resultJson?: string;
      failMsg?: string | null;
      response?: { resultUrls?: string[] };
    }>(key.api_key, `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);

    const d = r.data ?? {};
    const state = String(d.state ?? "waiting").toLowerCase();

    // resultJson نص يحتاج JSON.parse ثانيًا — مع احتياط حقل response.resultUrls إن توفر
    let urls: string[] | undefined;
    if (d.resultJson) {
      try {
        const parsed = JSON.parse(d.resultJson) as { resultUrls?: string[] };
        if (Array.isArray(parsed.resultUrls)) urls = parsed.resultUrls.filter((u) => typeof u === "string" && u.startsWith("http"));
      } catch {
        // تجاهل — قد يأتي بالنتائج في response
      }
    }
    if ((!urls || urls.length === 0) && Array.isArray(d.response?.resultUrls)) {
      urls = d.response.resultUrls.filter((u) => typeof u === "string" && u.startsWith("http"));
    }

    if (state === "success") {
      if (!urls?.length) return { status: "failed", error: "انتهت المهمة دون روابط نتائج لدى kie.ai" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail" || state === "failed") {
      return { status: "failed", error: d.failMsg ? String(d.failMsg) : "فشل التوليد لدى kie.ai" };
    }

    // تقدير تقدم حي حسب الحالة (waiting → queuing → generating)
    const progress = state === "generating" ? 45 : state === "queuing" ? 20 : 8;
    return { status: "processing", progress };
  },
};
