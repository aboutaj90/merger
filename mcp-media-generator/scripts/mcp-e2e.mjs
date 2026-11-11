/**
 * اختبار e2e حقيقي عبر MCP — يشغّل اللامتسلسل بالترتيب:
 * 1) توليد صورة بمفتاح صحيح → رابط يعمل
 * 2) التبديل التسلسلي: مفتاح خاطئ أولًا ثم الصحيح → نفس المهمة تكتمل على الثاني والخاطئ disabled
 * 3) توليد فيديو → task_id → get_task حتى رابط صالح
 * 4) دمج مقطعين عبر merge_videos → رابط MP4 نهائي
 * 5) list_media يعيد المهام
 * الاستخدام: node scripts/mcp-e2e.mjs [--skip-video]
 */
const BASE = process.env.TEST_BASE || "http://localhost:3000";
const SKIP_VIDEO = process.argv.includes("--skip-video");

let sessionId = null;
let idCounter = 10;
const createdTasks = []; // للتنظيف لاحقًا

async function callMcp(method, params) {
  const id = idCounter++;
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const raw = await res.text();
  let data = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) { try { data = JSON.parse(line.slice(5)); } catch {} break; }
  }
  if (!data) { try { data = JSON.parse(raw); } catch {} }
  if (!data) throw new Error(`استجابة غير مفهومة: ${raw.slice(0, 300)}`);
  return data;
}

async function toolCall(name, args) {
  const r = await callMcp("tools/call", { name, arguments: args });
  if (r.error) return { ok: false, text: JSON.stringify(r.error) };
  const text = r.result?.content?.[0]?.text ?? "";
  return { ok: !r.result?.isError, text };
}

async function getTaskUntilDone(taskId, maxSec = 360, everySec = 10) {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > maxSec * 1000) return { status: "timeout", text: "انتهت مهلة الانتظار" };
    await sleep(everySec * 1000);
    const r = await toolCall("get_task", { task_id: taskId });
    const t = r.text;
    if (t.includes("✅")) return { status: "completed", text: t };
    if (t.includes("❌")) return { status: "failed", text: t };
    process.stdout.write(".");
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0]);
}

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

async function main() {
  console.log("== 0) التهيئة ==");
  const init = await callMcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e-test", version: "1.0" } });
  ok("initialize يعيد serverInfo", init.result?.serverInfo?.name === "media-generator-mcp", JSON.stringify(init.result?.serverInfo));
  await callMcp("notifications/initialized", {});

  // 1) توليد صورة
  console.log("== 1) توليد صورة عبر generate_image ==");
  const img = await toolCall("generate_image", { prompt: "a tiny blue paper boat on a calm lake at sunrise, minimal illustration", wait_seconds: 90 });
  const imgUrls = extractUrls(img.text);
  ok("الرد يحوي رابط صورة", imgUrls.length > 0, imgUrls[0]?.slice(0, 80));
  if (imgUrls.length) {
    const head = await fetch(imgUrls[0], { method: "GET" });
    ok("رابط الصورة يعمل", head.ok, `HTTP ${head.status} ${head.headers.get("content-type")}`);
  }
  const imgTaskId = (img.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
  if (imgTaskId) createdTasks.push(imgTaskId);

  // 2) التبديل التسلسلي: مفتاح خاطئ أولًا ثم مفتاح صحيح → نفس المهمة تكتمل على الثاني
  console.log("== 2) التبديل التسلسلي (مفتاح خاطئ أولًا ثم الصحيح) ==");
  // نظّف المفاتيح ثم أضف الخاطئ أولًا (فيصبح أقدم = أول من يُجرَّب) ثم الصحيح
  const keysBefore = await (await fetch(`${BASE}/api/keys`)).json();
  for (const k of keysBefore.keys || []) {
    await fetch(`${BASE}/api/keys/${k.id}`, { method: "DELETE" });
  }
  const VALID_KEY = process.env.KIE_VALID_KEY;
  const addBad = await fetch(`${BASE}/api/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "kie", api_key: "INVALID_KEY_FOR_FAILOVER_TEST_123456", label: "مفتاح اختبار فاشل" }) });
  const addGood = await fetch(`${BASE}/api/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "kie", api_key: VALID_KEY, label: "الحساب الرئيسي" }) });
  ok("إضافة مفتاحين (خاطئ أولًا ثم صحيح)", addBad.status === 201 && addGood.status === 201);

  const img2 = await toolCall("generate_image", { prompt: "a small green cactus in a clay pot, flat design", wait_seconds: 90 });
  ok("المهمة اكتملت على المفتاح الثاني رغم فشل الأول", img2.text.includes("✅"), img2.text.slice(0, 100).replace(/\n/g, " "));
  ok("لا ذكر للمفاتيح أو الرصيد في الرد", !/مفتاح|رصيد|insufficient|unauthorized/i.test(img2.text), "");
  const img2TaskId = (img2.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
  if (img2TaskId) createdTasks.push(img2TaskId);

  const keysAfter = await (await fetch(`${BASE}/api/keys`)).json();
  const invalidKey = (keysAfter.keys || []).find((k) => k.label === "مفتاح اختبار فاشل");
  const validKey = (keysAfter.keys || []).find((k) => k.label === "الحساب الرئيسي");
  ok("المفتاح الخاطئ أصبح disabled", invalidKey && invalidKey.status === "disabled", invalidKey ? invalidKey.status : "غير موجود");
  ok("المفتاح الصحيح سليم ونجح استخدامه", validKey && validKey.status === "active" && validKey.successCount >= 1, validKey ? `${validKey.maskedKey} → ${validKey.status}` : "غير موجود");

  // نظّف مفتاح الاختبار الفاشل بعد التحقق
  if (invalidKey) await fetch(`${BASE}/api/keys/${invalidKey.id}`, { method: "DELETE" });

  // 3) توليد فيديو
  if (!SKIP_VIDEO) {
    console.log("== 3) توليد فيديو عبر generate_video (قد يستغرق دقائق) ==");
    const vid = await toolCall("generate_video", { prompt: "a paper boat sailing on calm water at sunrise, gentle waves, birds in the sky", wait_seconds: 25 });
    const vidTaskId = (vid.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
    if (vid.text.includes("✅") && extractUrls(vid.text).length) {
      ok("الفيديو اكتمل خلال نافذة الانتظار", true, extractUrls(vid.text)[0]?.slice(0, 80));
    } else if (vidTaskId) {
      ok("أعاد task_id قيد المعالجة", true, vidTaskId.slice(0, 8));
      console.log("   تتبع بـ get_task كل 10 ثوانٍ:");
      const done = await getTaskUntilDone(vidTaskId, 360);
      ok("الفيديو اكتمل عبر get_task", done.status === "completed", done.status === "completed" ? extractUrls(done.text)[0]?.slice(0, 80) : done.text.slice(0, 120));
      createdTasks.push(vidTaskId);
      // 4) دمج مقطعين: رابط الفيديو المولد + رابط عام
      console.log("== 4) دمج عبر merge_videos ==");
      const vidUrl = extractUrls(done.text)[0];
      const merge = await toolCall("merge_videos", { urls: [vidUrl, "https://www.w3schools.com/html/mov_bbb.mp4"], wait_seconds: 90 });
      const mergeTaskId = (merge.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
      if (merge.text.includes("✅")) {
        ok("الدمج اكتمل", true, extractUrls(merge.text)[0]?.slice(0, 80));
        ok("تحذير 24 ساعة موجود", merge.text.includes("24 ساعة"));
        createdTasks.push(mergeTaskId);
      } else if (mergeTaskId) {
        const md = await getTaskUntilDone(mergeTaskId, 180, 5);
        ok("الدمج اكتمل عبر get_task", md.status === "completed", md.text.slice(0, 100).replace(/\n/g, " "));
        ok("تحذير 24 ساعة موجود", md.text.includes("24 ساعة"));
        createdTasks.push(mergeTaskId);
      } else {
        ok("الدمج اكتمل", false, merge.text.slice(0, 150).replace(/\n/g, " "));
      }
      // رفض أقل من مقطعين
      const bad = await toolCall("merge_videos", { urls: ["https://example.com/a.mp4"] });
      ok("رفض أقل من مقطعين برسالة عربية", !bad.ok && bad.text.includes("مقطعَين"), "");
    } else {
      ok("توليد الفيديو", false, vid.text.slice(0, 150).replace(/\n/g, " "));
    }
  } else {
    // دمج من روابط عامة فقط (بدون توليد فيديو)
    console.log("== 4) دمج مقطعين عامين عبر merge_videos ==");
    const merge = await toolCall("merge_videos", {
      urls: ["https://www.w3schools.com/html/mov_bbb.mp4", "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"],
      wait_seconds: 120,
    });
    const mergeTaskId = (merge.text.match(/task_id: ([0-9a-f-]+)/) || [])[1];
    if (merge.text.includes("✅")) {
      ok("الدمج اكتمل", true, extractUrls(merge.text)[0]?.slice(0, 80));
      ok("تحذير 24 ساعة موجود", merge.text.includes("24 ساعة"));
    } else if (mergeTaskId) {
      const md = await getTaskUntilDone(mergeTaskId, 180, 5);
      ok("الدمج اكتمل عبر get_task", md.status === "completed", md.text.slice(0, 120).replace(/\n/g, " "));
      ok("تحذير 24 ساعة موجود", md.text.includes("24 ساعة"));
      createdTasks.push(mergeTaskId);
    } else {
      ok("الدمج اكتمل", false, merge.text.slice(0, 150).replace(/\n/g, " "));
    }
    const bad = await toolCall("merge_videos", { urls: ["https://example.com/a.mp4"] });
    ok("رفض أقل من مقطعين برسالة عربية", !bad.ok && bad.text.includes("مقطعَين"), "");
    const many = await toolCall("merge_videos", { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.mp4`) });
    ok("رفض أكثر من 10 برسالة عربية", !many.ok && many.text.includes("10"), "");
  }

  // 5) list_media
  console.log("== 5) list_media ==");
  const list = await toolCall("list_media", { limit: 10 });
  ok("list_media يعيد المهام المخزنة", list.text.includes("task_id:"), "");

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  console.log(`(معرفات مهام الاختبار للتنظيف: ${createdTasks.join(", ") || "لا شيء"})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("✗ فشل غير متوقع:", e); process.exit(1); });
