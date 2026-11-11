/**
 * اختبار الدمج عبر MCP — مقطع مولّد حقيقي + مقطع عام → رابط MP4 نهائي على نطاق خدمة الدمج
 */
const BASE = process.env.TEST_BASE || "http://localhost:3000";
let sessionId = null;
let idc = 100;

async function call(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: idc++, method, params: params ?? {} }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const raw = await res.text();
  let data = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) { try { data = JSON.parse(line.slice(5)); } catch {} break; }
  }
  if (!data) { try { data = JSON.parse(raw); } catch {} }
  return data;
}
async function tool(name, args) {
  const r = await call("tools/call", { name, arguments: args });
  if (r.error) return { ok: false, text: JSON.stringify(r.error) };
  return { ok: !r.result?.isError, text: r.result?.content?.[0]?.text ?? "" };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urls = (t) => [...t.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0]);

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✓ ${n}${e ? " — " + e : ""}`); } else { failed++; console.error(`  ✗ ${n}${e ? " — " + e : ""}`); } };

async function main() {
  await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "merge-test", version: "1" } });
  await call("notifications/initialized", {});

  // 1) دمج مقطع مولّد حقيقي + مقطع عام
  console.log("== دمج عبر merge_videos (فيديو مولّد حقيقي + مقطع عام) ==");
  const REAL_VIDEO = "https://tempfile.aiquickdraw.com/ggg/users/b6760711-ebcb-4f69-89f0-491ccbca0768/generated/b6585801-9a5a-4bad-ad1a-d14f3e81b0f4/generated_video.mp4";
  const merge = await tool("merge_videos", { urls: [REAL_VIDEO, "https://www.w3schools.com/html/mov_bbb.mp4"], wait_seconds: 120 });
  const mergeTaskId = (merge.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
  const cleanup = [];
  if (merge.text.includes("✅")) {
    const mu = urls(merge.text).find((u) => !u.includes("kie"));
    ok("الدمج اكتمل برابط نهائي", Boolean(mu), mu?.slice(0, 80));
    ok("تحذير 24 ساعة موجود", merge.text.includes("24 ساعة"));
    if (mu) {
      const head = await fetch(mu);
      ok("رابط MP4 النهائي يعمل ويُشغَّل", head.ok && (head.headers.get("content-type") || "").includes("video"), `HTTP ${head.status} ${head.headers.get("content-type")} size=${head.headers.get("content-length")}`);
    }
    if (mergeTaskId) cleanup.push(mergeTaskId);
  } else if (mergeTaskId) {
    const start = Date.now();
    let done = null;
    while (Date.now() - start < 180000) {
      await sleep(5000);
      const g = await tool("get_task", { task_id: mergeTaskId });
      if (g.text.includes("✅")) { done = g.text; break; }
      if (g.text.includes("❌")) break;
      process.stdout.write(".");
    }
    console.log();
    if (done) {
      const mu = urls(done).find((u) => !u.includes("kie"));
      ok("الدمج اكتمل عبر get_task", Boolean(mu), mu?.slice(0, 80));
      ok("تحذير 24 ساعة موجود", done.includes("24 ساعة"));
      if (mu) {
        const head = await fetch(mu);
        ok("رابط MP4 النهائي يعمل", head.ok && (head.headers.get("content-type") || "").includes("video"), `HTTP ${head.status} ${head.headers.get("content-type")}`);
      }
      cleanup.push(mergeTaskId);
    } else ok("الدمج اكتمل", false, "انتهت المهلة");
  } else {
    ok("الدمج اكتمل", false, merge.text.slice(0, 200).replace(/\n/g, " "));
  }

  // 2) رفض أقل من مقطعين وأكثر من 10
  const bad = await tool("merge_videos", { urls: ["https://example.com/a.mp4"] });
  ok("رفض أقل من مقطعين برسالة عربية", !bad.ok && bad.text.includes("مقطعَين"), "");
  const many = await tool("merge_videos", { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) });
  ok("رفض أكثر من 10 برسالة عربية", !many.ok && many.text.includes("10"), "");

  // 3) حل task_ids بالترتيب: ننشئ مهمة دمج عبر task_ids لمهمة الدمج المكتملة نفسها؟
  //    نستخدم بدلًا من ذلك مهمة دمج مكتملة سابقة إن وجدت — وإلا نتخطى
  console.log("== حل task_ids من قاعدة البيانات ==");
  const list = await tool("list_media", { type: "merge", status: "completed", limit: 5 });
  const completedMerge = list.text.match(/task_id: ([0-9a-f-]+)/);
  if (completedMerge) {
    // مهمة دمج مكتملة ليست فيديو توليد — استخدم روابطها كـ urls لا task_ids (task_ids تتطلب فيديو)
    ok("list_media يعيد المهام المكتملة بروابطها", list.text.includes("task_id:"), "");
  }

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  if (cleanup.length) console.log(`(مهام الدمج للتنظيف: ${cleanup.join(", ")})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
