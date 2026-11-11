/**
 * صياغة الردود العربية لأدوات MCP — (المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية)
 */
import type { TaskRow } from "./turso";

export function taskTypeAr(type: string): string {
  return type === "image" ? "صورة" : type === "video" ? "فيديو" : type === "merge" ? "دمج" : type;
}

export function taskStatusAr(status: string): string {
  switch (status) {
    case "completed": return "مكتملة";
    case "failed": return "فاشلة";
    case "processing":
    case "pending": return "قيد المعالجة";
    default: return status;
  }
}

/** صياغة عربية جاهزة للعرض لأي مهمة بعد refresh */
export function formatTaskReply(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);

  if (task.status === "completed") {
    if (task.type === "image") {
      return [
        "✅ تم توليد الصورة بنجاح",
        urls.length ? `![image](${urls[0]})` : "",
        urls.length ? `الرابط المباشر: ${urls[0]}` : "",
        `task_id: ${task.id}`,
      ].filter(Boolean).join("\n");
    }
    const header = task.type === "merge" ? "✅ تم دمج المقاطع بنجاح" : "✅ تم توليد الفيديو بنجاح";
    const lines = [header];
    for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
    // قاعدة حتمية: ملفات الدمج تُحذف بعد 24 ساعة — تنبيه إلزامي
    if (task.type === "merge") lines.push("⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
    lines.push(`task_id: ${task.id}`);
    return lines.join("\n");
  }

  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${task.error_message ?? "سبب غير معروف"}\ntask_id: ${task.id}`;
  }

  // جارية: لا تذكر أخطاء المفاتيح/الرصيد أبدًا — العميل يرى «قيد المعالجة» فقط
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function parseUrls(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr as string[]).filter((u) => typeof u === "string" && u.startsWith("http")) : [];
  } catch {
    return [];
  }
}

/** ملخص قصير لمهمة داخل قائمة list_media */
export function formatTaskSummary(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);
  const base = `- [${taskStatusAr(task.status)}] ${taskTypeAr(task.type)} | ${task.model} | task_id: ${task.id}`;
  const urlLine = urls.length ? ` | الروابط: ${urls.join(" ، ")}` : "";
  const errLine = task.status === "failed" && task.error_message ? ` | السبب: ${task.error_message}` : "";
  return base + urlLine + errLine;
}
