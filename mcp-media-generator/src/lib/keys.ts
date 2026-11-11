/**
 * طبقة المفاتيح — الترتيب التسلسلي الصارم وتصنيف الأخطاء
 *
 * القواعد الجوهرية:
 * - المفاتيح تُجرَّب بترتيب الإضافة بالضبط (created_at ASC, id ASC) — ليس round-robin.
 * - المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة؛ الاستثناء الوحيد هو التعطيل اليدوي (disabled).
 * - المفاتيح تُخفى دائمًا في كل الاستجابات (maskKey) ولا تُعاد كاملة أبدًا.
 */
import { type ApiKeyRow } from "./turso";
// التعريف الحقيقي في providers/types — يُعاد تصديره من هنا للمنسّق
export { ProviderError } from "./providers/types";
import { ProviderError } from "./providers/types";
void ProviderError;

/* ----------------------------- تصنيف الأخطاء ----------------------------- */

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const AUTH_PATTERNS = /invalid api key|unauthorized|forbidden|authentication|invalid_key|incorrect api key|api key not valid/i;
const EXHAUSTED_PATTERNS = /insufficient|quota|balance|credit|out of credits|exhausted|充值|no more credits|payment required|欠费/i;
const MODEL_PATTERNS = /model not found|unsupported model|model_not_found|does not exist|unknown model|not a valid model/i;

/**
 * تصنيف موحّد لكل أخطاء المزودين:
 * - disabled  : مفتاح مرفوض → تعطيل تلقائي → الانتقال للتالي
 * - exhausted : نفاد رصيد → تعليم المفتاح exhausted (يبقى في القاعدة) → الانتقال للتالي
 *   (نفاد الرصيد يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400)
 * - provider  : الموديل غير مدعوم لدى هذا المزود → الانتقال للتالي
 * - params    : معطيات الطلب تالفة → توقف فورًا (تبديل المفاتيح لن يحلها)
 * - temporary : 429/5xx/انقطاع شبكة/timeout → الانتقال للتالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(err: unknown): ErrorClass {
  let status = 0;
  let message = "";
  if (err instanceof ProviderError) {
    status = err.status;
    message = err.message ?? "";
  } else if (err instanceof Error) {
    // أخطاء الشبكة/الانقطاع/انتهاء المهلة بدون حالة HTTP
    message = err.message ?? "";
    if (/fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|aborted|timeout|socket hang up/i.test(message)) {
      return "temporary";
    }
    return "temporary";
  } else {
    return "temporary";
  }

  // 1) أنماط الرسائل أولًا (نفاد الرصيد قبل 400 كما تشترط المواصفة)
  if (EXHAUSTED_PATTERNS.test(message)) return "exhausted";
  if (AUTH_PATTERNS.test(message)) return "disabled";
  if (MODEL_PATTERNS.test(message) && [400, 404, 422].includes(status)) return "provider";

  // 2) حالات HTTP
  if (status === 401 || status === 403) return "disabled";
  if (status === 402) return "exhausted";
  if (status === 429 || status >= 500) return "temporary";
  if (status === 400 || status === 404 || status === 422) return "params";
  return "temporary";
}

/** هل رسالة فشل المهمة في منتصفها تشير لمشكلة مفتاح/رصيد (تستدعي التبديل الصامت)؟ */
export function looksLikeKeyOrBalanceFailure(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted|充值|欠费/i.test(msg);
}

/** فشل عابر لدى المزود نفسه (خطأ داخلي/تحميل) — يعاد الإنشاء بنفس task_id دون إبلاغ العميل */
export function looksLikeTransientProviderFailure(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /internal error|server error|try again|temporar|unavailable|service overloaded|timeout|backend error/i.test(msg);
}

/* ------------------------------- maskKey ------------------------------- */

/** إخفاء المفتاح إلزاميًا: أول 7 + •••••••• + آخر 4 (القصيرة: أول 3 + ••••) */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

/** شكل المفتاح المُعاد للواجهة — لا يُعاد المفتاح الكامل في أي استجابة */
export function publicKey(k: ApiKeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastCheckedAt: k.last_checked_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

/* --------------------- تحديث حالة المفتاح حسب التصنيف --------------------- */

import { updateApiKey } from "./turso";

/** طبّق أثر التصنيف على المفتاح: disabled/exhausted تُعلَّم تلقائيًا، الباقي يبقى سليمًا */
export async function applyKeyPenalty(key: ApiKeyRow, cls: ErrorClass, errMessage: string): Promise<void> {
  if (cls === "disabled") {
    // مفتاح مرفوض → تعطيل تلقائي (يبقى في القاعدة ومرئيًا في الواجهة مع سبب آخر خطأ)
    await updateApiKey(key.id, { status: "disabled", last_error: errMessage });
  } else if (cls === "exhausted") {
    // مستنزف → يُعلَّم exhausted ويبقى في القاعدة دون عرقلة المفاتيح التالية
    await updateApiKey(key.id, { status: "exhausted", last_error: errMessage });
  } else if (cls === "temporary") {
    // مؤقت — المفتاح يبقى سليمًا، نسجّل آخر خطأ فقط للمراقبة
    await updateApiKey(key.id, { last_error: errMessage });
  }
}
