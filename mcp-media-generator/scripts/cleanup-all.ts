// تنظيف كل آثار الاختبار من قاعدة Turso الحقيقية
import { createClient } from "@libsql/client";
const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// 1) حذف كل مهام الاختبار (كل المهام في هذه القاعدة جاءت من الاختبارات)
const t = await c.execute("SELECT id, type, status FROM tasks");
console.log("المهام قبل التنظيف:", t.rows.length);
await c.execute("DELETE FROM tasks");

// 2) تصفير عدّادات المفتاح الرئيسي وإعادته active لبداية نظيفة (آخر خطأ يُحفظ للمرجعية)
await c.execute(
  "UPDATE api_keys SET status = 'active', usage_count = 0, success_count = 0, fail_count = 0, last_error = NULL, last_used_at = NULL, last_checked_at = NULL"
);

// 3) حذف مهام الدمج من جداول خدمة الدمج (نفس القاعدة)
const j = await c.execute("SELECT id FROM jobs");
console.log("مهام الدمج قبل التنظيف:", j.rows.length);
for (const row of j.rows) {
  const id = String(row.id);
  await c.batch(
    [
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
}

// التحقق النهائي
const afterT = await c.execute("SELECT COUNT(*) AS n FROM tasks");
const afterK = await c.execute("SELECT label, status FROM api_keys");
const afterJ = await c.execute("SELECT COUNT(*) AS n FROM jobs");
const oc = await c.execute("SELECT COUNT(*) AS n FROM output_chunks");
const sc = await c.execute("SELECT COUNT(*) AS n FROM source_chunks");
console.log("المهام بعد:", afterT.rows[0].n, "| المفاتيح:", JSON.stringify(afterK.rows.map((r) => `${r.label}:${r.status}`)));
console.log("مهام الدمج بعد:", afterJ.rows[0].n, "| output_chunks:", oc.rows[0].n, "| source_chunks:", sc.rows[0].n);
