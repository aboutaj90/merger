/**
 * سجل الموديلات — أسماء موحّدة مع قبول الصيغ البديلة (شرطات/نقاط)
 * الموديلان المدمجان مثبّتان كما هما، والأسماء قابلة للتجاوز بمتغيرات البيئة.
 */
import type { ProviderId } from "./providers/types";

export type MediaType = "image" | "video" | "merge";
export type TaskProvider = ProviderId | "merger";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
// اسم الموديل لدى CometAPI بأسلوب تسميته (نقاط) — قابل للتجاوز بالبيئة
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

/** توحيد اسم الموديل: شرطة/نقطة تكافئ بعضها + تجاهل حالة الأحرف والمسافات */
function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[._]/g, "-");
}

/** البحث عن موديل بالاسم أو بالصيغ البديلة — يعيد null إن كان مجهولًا (خطأ معطيات) */
export function resolveModel(name: string | undefined): ModelDef | null {
  if (!name) return null;
  const target = normalizeName(name);
  return MODELS.find((m) => normalizeName(m.canonical) === target || m.aliases.some((a) => normalizeName(a) === target)) ?? null;
}

export function findModelByCanonical(canonical: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === canonical) ?? null;
}
