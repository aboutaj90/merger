/**
 * مزود CometAPI — وفق التوثيق الرسمي الحالي (apidoc.cometapi.com):
 *
 * صور متزامنة (متوافقة مع OpenAI):
 *   POST https://api.cometapi.com/v1/images/generations
 *   {"model":"<providerModel>","prompt":"..."}  → {"data":[{"url": "..."} | {"b64_json":"..."}]}
 *
 * فيديو غير متزامن (نمط create/check):
 *   POST https://api.cometapi.com/grok/v1/videos/generations
 *   {"model":"grok-imagine-video-1.5","prompt":"...","duration":8,"aspect_ratio":"16:9","resolution":"480p",
 *    "image":{"url":"..."}}  → {"request_id":"..."}
 *   GET https://api.cometapi.com/grok/v1/videos/{request_id}
 *   → {"status":"pending|done|failed|expired","progress":35,"video":{"url":"..."},"error":...}
 */
import { ProviderError, PROVIDER_TIMEOUT_MS, type ProviderAdapter, type ProviderKey } from "./types";

async function cometFetch(key: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
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
    throw new ProviderError(503, `temporary network error: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // رسائل مثل insufficient credits/quota تُصنَّف لاحقًا في classifyProviderError
    const err = (body?.error as { message?: string })?.message
      ?? (body?.message as string)
      ?? JSON.stringify(body ?? {});
    throw new ProviderError(res.status, String(err));
  }
  if (!body) throw new ProviderError(res.status || 500, "CometAPI غير متوقع: استجابة بلا جسم JSON");
  return body;
}

export const cometAdapter: ProviderAdapter = {
  /** CometAPI تعيد الصورة فورًا (متزامنة) */
  async createImageSync(key: ProviderKey, providerModel: string, input: Record<string, unknown>) {
    const body = await cometFetch(key.api_key, "https://api.cometapi.com/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        // الحقول الاختيارية تمر كما هي إن وُجدت (background/output_format/...)
        ...(typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(typeof input.resolution === "string" && input.resolution !== "1K" ? { size: input.resolution } : {}),
        ...(input.background ? { background: input.background } : {}),
        ...(input.output_format ? { output_format: input.output_format } : {}),
      }),
    });
    const data = body.data as Array<{ url?: string; b64_json?: string }> | undefined;
    const urls: string[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item?.url === "string" && item.url.startsWith("http")) urls.push(item.url);
        else if (typeof item?.b64_json === "string") urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (!urls.length) throw new ProviderError(502, "CometAPI لم يعرد رابط صورة");
    return { urls };
  },

  async createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>) {
    const body = await cometFetch(key.api_key, "https://api.cometapi.com/grok/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify({
        model: providerModel,
        prompt: input.prompt,
        ...(typeof input.duration === "number" ? { duration: input.duration } : {}),
        ...(typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(typeof input.resolution === "string" && input.resolution !== "auto" ? { resolution: input.resolution } : {}),
        ...(typeof input.image_url === "string" && input.image_url.startsWith("http") ? { image: { url: input.image_url } } : {}),
      }),
    });
    const requestId = body.request_id ?? (body.data as { request_id?: string } | undefined)?.request_id;
    if (typeof requestId !== "string" || !requestId) throw new ProviderError(502, "CometAPI لم يعرد request_id");
    return { providerTaskId: requestId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const body = await cometFetch(key.api_key, `https://api.cometapi.com/grok/v1/videos/${encodeURIComponent(providerTaskId)}`);
    const status = String(body.status ?? "pending").toLowerCase();
    const progress = typeof body.progress === "number" ? body.progress : undefined;
    const video = body.video as { url?: string } | undefined;

    if (status === "done") {
      const url = typeof video?.url === "string" && video.url.startsWith("http") ? video.url : undefined;
      if (!url) return { status: "failed", error: "انتهت المهمة دون رابط فيديو لدى CometAPI" };
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "expired") {
      const err = body.error;
      const msg = typeof err === "string" ? err : err ? JSON.stringify(err) : "فشل التوليد لدى CometAPI";
      return { status: "failed", error: msg };
    }
    return { status: "processing", progress: typeof progress === "number" ? progress : 30 };
  },
};
