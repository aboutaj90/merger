// إعادة إنتاج اختبار التبديل التسلسلي عبر منسّق التوليد مباشرة
import { getKeyPool, listKeys, insertApiKey, getTask, deleteApiKey } from "../src/lib/turso";
import { runGeneration, refreshTask } from "../src/lib/generation";

async function main() {
  // نظّف المفاتيح: خاطئ أولًا ثم صحيح
  const before = await listKeys();
  for (const k of before) await deleteApiKey(k.id);

  await insertApiKey({ id: "bad-1", provider: "kie", label: "خاطئ", api_key: "INVALID_KEY_FOR_FAILOVER_TEST_123456" });
  await insertApiKey({ id: "good-1", provider: "kie", label: "صحيح", api_key: process.env.KIE_VALID_KEY! });

  const pool = await getKeyPool(["kie", "cometapi"]);
  console.log("POOL:", pool.map((k) => k.label));

  const { task } = await runGeneration({ prompt: "probe: tiny red square", wait_seconds: 0 }, "image", {});
  console.log("TASK:", task?.id, "status:", task?.status, "provider:", task?.provider);
  const t = await getTask(task!.id);
  console.log("ATTEMPTS:", JSON.stringify(t?.attempts_json, null, 1).slice(0, 600));

  const keys = await listKeys();
  for (const k of keys) console.log("KEY:", k.label, k.status, "usage:", k.usage_count, "fail:", k.fail_count, "err:", (k.last_error ?? "").slice(0, 60));

  // نظّف: احذف المفتاح الخاطئ والمهمة التجريبية
  const bad = (await listKeys()).find((k) => k.label === "خاطئ");
  if (bad) await deleteApiKey(bad.id);
  process.exit(0);
}

main().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
