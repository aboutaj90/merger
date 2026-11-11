/** أنواع مشتركة لمزودي التوليد */
export type ProviderId = "kie" | "cometapi";

export interface ProviderKey {
  id: string;
  provider: string;
  api_key: string;
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId */
  createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا) */
  createImageSync?(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(
    key: ProviderKey,
    providerTaskId: string
  ): Promise<{
    status: "processing" | "completed" | "failed";
    urls?: string[];
    error?: string;
    progress?: number;
  }>;
}

/** خطأ يرميه مزود — يُصنَّف لاحقًا في classifyProviderError (طبقة المفاتيح) */
export class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** مهلة افتراضية لنداءات المزودين (30 ثانية) */
export const PROVIDER_TIMEOUT_MS = 30_000;
