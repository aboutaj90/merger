/**
 * منسّق التوليد — القلب التشغيلي: runGeneration / refreshTask / runMerge / refreshMergeTask
 *
 * سلوك التبديل «لا توقف أبدًا»:
 * 1. عند الإنشاء: تجربة المرشحين بالترتيب التسلسلي الصارم؛ أول نجاح يربط المهمة بالمزود والمفتاح.
 * 2. فشل منتصف المهمة بسبب مفتاح/رصيد: إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي صامتةً.
 * 3. فشل الإنشاء على كل المفاتيح: المهمة تبقى processing بـ«بانتظار توفر مفتاح صالح…»
 *    وتُعاد المحاولة تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية.
 * 4. نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
 */
import { randomUUID } from "node:crypto";
import {
  getTask,
  insertTask,
  updateTask,
  getKey,
  getKeyPool,
  bumpKeyUsage,
  type TaskRow,
  type TaskAttempt,
} from "./turso";
import {
  ProviderError,
  classifyProviderError,
  applyKeyPenalty,
  looksLikeKeyOrBalanceFailure,
  looksLikeTransientProviderFailure,
  type ErrorClass,
} from "./keys";
import { resolveModel, findModelByCanonical, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometAdapter } from "./providers/cometapi";
import { type ProviderAdapter, type ProviderKey } from "./providers/types";
import {
  MERGER_BASE,
  MERGER_LIMITS,
  mergerCreateJob,
  mergerProcess,
  mergerGetJob,
  type MergerStatus,
} from "./merger";

const ADAPTERS: Record<string, ProviderAdapter> = { kie: kieAdapter, cometapi: cometAdapter };

/** تهدئة إعادة المحاولة عند انتظار توفر مفتاح صالح (ثوانٍ) */
const KEY_WAIT_COOLDOWN_SEC = 45;
/** الفاصل بين استعلامات حالة المزود أثناء نافذة الانتظار (مللي ثانية) */
const POLL_INTERVAL_MS = 3_000;

/** قفل في الذاكرة: مهام الدمج التي يجري تنفيذ process لها الآن — حتى لا تتزامن مع get_task */
const processInFlight = new Set<string>();

/* ------------------------------- أدوات مساعدة ------------------------------- */

function toProviderKey(k: { id: string; provider: string; api_key: string }): ProviderKey {
  return { id: k.id, provider: k.provider, api_key: k.api_key };
}

function makeAttempt(key: { id: string; label?: string }, provider: string, ok: boolean, errorClass?: ErrorClass, error?: string): TaskAttempt {
  return { provider, keyId: key.id, keyLabel: key.label || undefined, ok, errorClass, error: error?.slice(0, 300), at: new Date().toISOString() };
}

/** رسالة انتظار المفاتيح الداخلية — لا تخرج للعميل كخطأ أبدًا */
const WAITING_FOR_KEYS_MSG = "بانتظار توفر مفتاح صالح…";

/** هل انتهت تهدئة الانتظار؟ (تقارن updated_at بالآن) */
function cooldownElapsed(task: TaskRow, sec: number): boolean {
  if (!task.updated_at) return true;
  const last = Date.parse(task.updated_at.endsWith("Z") ? task.updated_at : `${task.updated_at.replace(" ", "T")}Z`);
  if (Number.isNaN(last)) return true;
  return (Date.now() - last) / 1000 >= sec;
}

export interface ProgressSink {
  /** إرسال progress notification للعميل إن زوّد الطلب بـ progressToken */
  sendProgress(progress: number, total: number, message: string): Promise<void>;
}

const noopSink: ProgressSink = { sendProgress: async () => {} };

/* =========================== إنشاء مهمة توليد =========================== */

interface CreateResult {
  task: TaskRow;
  completed: boolean;
}

/**
 * جرّب المرشحين بالترتيب حتى نجاح الإنشاء على مزود.
 * على نجاح: يحدّث المهمة بالمزود/المفتاح ويعيد def للانتظار.
 * فشل params يوقف كل شيء فورًا (خطأ حتمي).
 */
async function tryCreateOnCandidates(
  task: TaskRow,
  def: ModelDef,
  input: Record<string, unknown>,
  startIdx = 0
): Promise<{ created: boolean; keyIdx: number; fatalParamsError?: string }> {
  const pool = await getKeyPool(def.providers);
  for (let i = startIdx; i < pool.length; i++) {
    const key = pool[i];
    const adapter = ADAPTERS[key.provider];
    const providerModel = def.providerModel[key.provider as keyof typeof def.providerModel] ?? def.canonical;
    if (!adapter) continue;

    try {
      if (def.type === "image" && adapter.createImageSync) {
        // صور متزامنة (CometAPI): النتيجة كاملة فورًا — نجاح مباشر دون انتظار
        const { urls } = await adapter.createImageSync(toProviderKey(key), providerModel, input);
        await updateTask(task.id, {
          provider: key.provider,
          provider_task_id: null,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
        });
        await bumpKeyUsage(key.id, { ok: true });
        await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, true) });
        return { created: true, keyIdx: i };
      }
      const { providerTaskId } = await adapter.createTask(toProviderKey(key), providerModel, input);
      await updateTask(task.id, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        error_message: null,
      });
      await bumpKeyUsage(key.id, { ok: true });
      await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, true) });
      return { created: true, keyIdx: i };
    } catch (e: unknown) {
      const cls = classifyProviderError(e);
      const msg = e instanceof Error ? e.message : String(e);
      // كل محاولة (نجاح أو فشل + الفئة) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا
      await bumpKeyUsage(key.id, { ok: false, errorClass: cls, error: msg });
      await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, false, cls, msg) });
      await applyKeyPenalty(key, cls, msg);

      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        return { created: false, keyIdx: i, fatalParamsError: msg };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي
      continue;
    }
  }
  return { created: false, keyIdx: pool.length };
}

/* ============================ نافذة الانتظار ============================ */

/** استعلم حالة المزود لمهمة جارية — مع التبديل الصامت عند فشل مفتاح/رصيد في المنتصف */
async function pollProviderTask(task: TaskRow, def: ModelDef, sink: ProgressSink): Promise<TaskRow> {
  const provider = task.provider;
  const adapter = provider ? ADAPTERS[provider] : undefined;
  const keyId = task.key_id;

  if (!provider || !adapter || !keyId) return task;

  let key = await getKey(keyId);

  // المفتاح الحالي صار disabled؟ → التبديل فورًا إلى التالي دون انتظار فشل المزود
  if (!key || key.status === "disabled") {
    return await recreateOnNextKey(task, def, provider, keyId, sink);
  }

  let check;
  try {
    check = await adapter.checkTask(toProviderKey(key), task.provider_task_id!);
  } catch (e: unknown) {
    const cls = classifyProviderError(e);
    const msg = e instanceof Error ? e.message : String(e);
    await bumpKeyUsage(key.id, { ok: false, errorClass: cls, error: msg });
    await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, false, cls, msg) });
    await applyKeyPenalty(key, cls, msg);
    if (cls === "params") {
      await updateTask(task.id, { status: "failed", error_message: `معطيات غير مدعومة: ${msg}` });
      return (await getTask(task.id))!;
    }
    // temporary/exhausted/disabled/provider → أعد الإنشاء على المفتاح التالي بنفس task_id
    return await recreateOnNextKey(task, def, provider, keyId, sink);
  }

  if (check.status === "completed") {
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls_json: JSON.stringify(check.urls ?? []),
      error_message: null,
    });
  } else if (check.status === "failed") {
    const msg = check.error ?? "فشل التوليد لدى المزود";
    if (looksLikeKeyOrBalanceFailure(msg)) {
      // فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي
      await bumpKeyUsage(key.id, { ok: false, errorClass: "exhausted", error: msg });
      await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, false, "exhausted", msg) });
      await applyKeyPenalty(key, "exhausted", msg);
      return await recreateOnNextKey(task, def, provider, keyId, sink);
    }
    if (looksLikeTransientProviderFailure(msg)) {
      // فشل عابر لدى المزود (مثل Internal Error) → إعادة إنشاء بنفس task_id على المفتاح التالي دون إبلاغ العميل
      await bumpKeyUsage(key.id, { ok: false, errorClass: "temporary", error: msg });
      await updateTask(task.id, { append_attempt: makeAttempt(key, key.provider, false, "temporary", msg) });
      return await recreateOnNextKey(task, def, provider, keyId, sink);
    }
    // فشل حقيقي (انتهاك سياسة/معطيات) → failed
    await updateTask(task.id, { status: "failed", error_message: msg });
  } else {
    const progress = typeof check.progress === "number" ? check.progress : Math.min(90, task.progress + 5);
    await updateTask(task.id, { progress: Math.max(task.progress, progress) });
    await sink.sendProgress(Math.max(task.progress, progress), 100, "قيد التوليد…");
  }
  return (await getTask(task.id))!;
}

/** أعد إنشاء نفس المهمة (نفس task_id) على المفتاح التالي في الترتيب التسلسلي */
async function recreateOnNextKey(
  task: TaskRow,
  def: ModelDef,
  fromProvider: string,
  fromKeyId: string,
  sink: ProgressSink
): Promise<TaskRow> {
  const pool = await getKeyPool(def.providers);
  const curIdx = pool.findIndex((k) => k.id === fromKeyId);

  const freshInput = safeParseInput(task);
  // جرّب المرشحين بدءًا من بعد المفتاح الحالي (الترتيب التسلسلي الصارم)
  let startIdx = curIdx + 1;
  let result = await tryCreateOnCandidates(task, def, freshInput, startIdx);

  // نفد من نهاية القائمة؟ لفّ للبداية مرة واحدة (المفاتيح السابقة سليمة ربما استُنزفت مؤقتًا وخدمت مهمة أخرى)
  if (!result.created && curIdx >= 0 && startIdx > 0) {
    result = await tryCreateOnCandidates(task, def, freshInput, 0);
  }

  if (!result.created) {
    // كل المفاتيح فشلت → تبقى processing (ليست failed) بانتظار توفر مفتاح صالح
    if (result.fatalParamsError) {
      await updateTask(task.id, { status: "failed", error_message: `معطيات غير مدعومة: ${result.fatalParamsError}` });
    } else {
      await updateTask(task.id, { provider: null, provider_task_id: null, key_id: null, status: "processing", error_message: WAITING_FOR_KEYS_MSG, progress: 0 });
      await sink.sendProgress(0, 100, WAITING_FOR_KEYS_MSG);
    }
  }
  return (await getTask(task.id))!;
}

function safeParseInput(task: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(task.params_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ============================== runGeneration ============================== */

/**
 * التدفق لأداة generate_image / generate_video:
 * 1. وحّد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري.
 * 2. جلب المرشحين — فارغ → رد no_keys برسالة عربية.
 * 3. سجّل المهمة في Turso قبل أي نداء خارجي.
 * 4. جرّب المرشحين بالترتيب حتى نجاح الإنشاء.
 * 5. نافذة انتظار wait_seconds (0–240؛ الافتراضي 90 للصور و25 للفيديو): استعلام كل 3 ثوانٍ + بث تقدم.
 * 6. اكتمل → خزّن الروابط وأعد المهمة المكتملة. فشل مفتاح/رصيد → تبديل صامت بنفس task_id.
 * 7. انتهت النافذة دون نتيجة → أعد بحالة processing مع task_id (العميل يتابع بـ get_task).
 */
export async function runGeneration(
  args: { prompt: string; model?: string; wait_seconds?: number },
  type: "image" | "video",
  extraInput: Record<string, unknown>,
  sink: ProgressSink = noopSink
): Promise<{ task: TaskRow | null; noKeysMessage?: string; paramsError?: string }> {
  const def = resolveModel(args.model) ?? findModelByCanonical(type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview");
  if (!def || def.type !== type) {
    return { task: null, paramsError: "اسم الموديل غير معروف" };
  }

  const waitSeconds = clampWait(args.wait_seconds, type === "image" ? 90 : 25);

  // 2) جلب المفاتيح — فارغ → رد no_keys
  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    return {
      task: null,
      noKeysMessage: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 3) سجّل المهمة قبل أي نداء خارجي (حتى لو انقطع الاتصال تبقى قابلة للتتبع)
  const taskId = randomUUID();
  const input: Record<string, unknown> = { prompt: args.prompt, ...extraInput };
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt: args.prompt,
    params_json: JSON.stringify(input),
    status: "pending",
  });
  let task = (await getTask(taskId))!;

  // 4) جرّب المرشحين بالترتيب
  const created = await tryCreateOnCandidates(task, def, input, 0);
  if (created.fatalParamsError) {
    await updateTask(task.id, { status: "failed", error_message: `معطيات غير مدعومة: ${created.fatalParamsError}` });
    return { task: (await getTask(taskId))!, paramsError: created.fatalParamsError };
  }
  if (!created.created) {
    // كل المفاتيح فشلت → processing بانتظار مفتاح صالح (وليست failed)
    await updateTask(task.id, { status: "processing", error_message: WAITING_FOR_KEYS_MSG });
    return { task: (await getTask(taskId))! };
  }

  // 5) نافذة الانتظار مع بث التقدم والتبديل الصامت
  task = (await getTask(taskId))!;
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    task = (await getTask(taskId))!;
    if (!task) break;
    if (task.status === "completed" || task.status === "failed") break;

    // انتظار توفر مفتاح: أعِد المحاولة بعد التهدئة فقط
    if (!task.provider_task_id && task.provider === null) {
      if (cooldownElapsed(task, KEY_WAIT_COOLDOWN_SEC)) {
        const again = await tryCreateOnCandidates(task, def, safeParseInput(task), 0);
        if (again.fatalParamsError) {
          await updateTask(task.id, { status: "failed", error_message: `معطيات غير مدعومة: ${again.fatalParamsError}` });
          break;
        }
      }
      continue;
    }

    if (task.provider && task.provider_task_id) {
      task = await pollProviderTask(task, def, sink);
    }
  }

  return { task: (await getTask(taskId))! };
}

/* ================================ get_task ================================ */

/**
 * refreshTask: المهمة الجارية تُحدَّث حية من المزود (أو خدمة الدمج) مع نفس منطق
 * إعادة المحاولة/التبديل، ثم تُرجع الحالة المحدثة.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;

  if (task.status === "completed" || task.status === "failed") return task;
  const sink = noopSink;

  if (task.type === "merge") return await refreshMergeTask(task, sink);

  const def = findModelByCanonical(task.model);
  if (!def) {
    await updateTask(task.id, { status: "failed", error_message: "موديل المهمة غير معروف" });
    return (await getTask(taskId))!;
  }

  // بانتظار توفر مفتاح صالح: أعِد المحاولة تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية
  if (!task.provider_task_id) {
    if (cooldownElapsed(task, KEY_WAIT_COOLDOWN_SEC)) {
      const again = await tryCreateOnCandidates(task, def, safeParseInput(task), 0);
      if (again.fatalParamsError) {
        await updateTask(task.id, { status: "failed", error_message: `معطيات غير مدعومة: ${again.fatalParamsError}` });
      }
    }
    return (await getTask(taskId))!;
  }

  if (task.provider && task.provider_task_id) {
    return await pollProviderTask(task, def, sink);
  }
  return task;
}

/* ================================ runMerge ================================ */

/**
 * تدفق runMerge وقواعده (7.3):
 * 1. تحقق صارم: ≥2 رابط http/https مباشرة عامة؛ >10 → رفض.
 * 2. سجّل مهمة merge في Turso أولًا.
 * 3. POST /api/jobs ثم process خلفيًا وبمرة واحدة فقط (قفل processInFlight).
 * 4. نافذة انتظار (افتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم وكتابة فورية في Turso.
 * 5. خطأ HTTP معلن = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة → استمر بالاستعلام حتى نهاية النافذة.
 */
export async function runMerge(
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  sink: ProgressSink = noopSink
): Promise<{ task: TaskRow | null; validationError?: string; failedResolutions?: string[] }> {
  const failedResolutions: string[] = [];

  // حل روابط task_ids أولًا (لمهام فيديو مكتملة) ثم urls المباشرة بنفس ترتيبها
  const orderedUrls: string[] = [];
  if (Array.isArray(args.task_ids) && args.task_ids.length) {
    for (const tid of args.task_ids) {
      const t = await getTask(String(tid));
      if (!t || t.type !== "video" || t.status !== "completed") {
        failedResolutions.push(`${tid}: ${!t ? "غير موجودة" : t.type !== "video" ? "ليست مهمة فيديو" : t.status === "processing" ? "لم تكتمل بعد" : "فاشلة أو بلا روابط"}`);
        continue;
      }
      let urls: string[] = [];
      try {
        urls = JSON.parse(t.result_urls_json ?? "[]") as string[];
      } catch {
        urls = [];
      }
      const valid = urls.filter((u) => /^https?:\/\//i.test(u));
      if (!valid.length) failedResolutions.push(`${tid}: لا روابط نتائج`);
      else orderedUrls.push(...valid);
    }
  }
  if (Array.isArray(args.urls) && args.urls.length) orderedUrls.push(...args.urls.map(String));

  // 1) تحقق صارم
  if (orderedUrls.length < 2) {
    return {
      task: null,
      validationError:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." +
        (failedResolutions.length ? `\nتفاصيل المعرفات الفاشلة:\n- ${failedResolutions.join("\n- ")}` : ""),
    };
  }
  const notHttp = orderedUrls.filter((u) => !/^https?:\/\//i.test(u));
  if (notHttp.length) {
    return { task: null, validationError: `❌ كل الروابط يجب أن تكون http/https مباشرة عامة. روابط غير صالحة:\n- ${notHttp.join("\n- ")}` };
  }
  if (orderedUrls.length > MERGER_LIMITS.maxVideos) {
    return { task: null, validationError: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }

  // 2) سجّل المهمة أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${orderedUrls.length} مقاطع`,
    params_json: JSON.stringify({ urls: orderedUrls, wait_seconds: clampWait(args.wait_seconds, 60) }),
    status: "processing",
  });
  const task = (await getTask(taskId))!;

  // 3) إنشاء المهمة لدى الخدمة ثم process خلفيًا بمرة واحدة
  let jobId: string;
  try {
    const created = await mergerCreateJob(orderedUrls);
    jobId = created.jobId;
    await updateTask(task.id, { provider_task_id: jobId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // خطأ معلن من الخدمة = فشل نهائي؛ خطأ شبكتنا = مؤقت (يبقى processing ليعاد مع get_task)
    if (e instanceof ProviderError && e.status !== 0) {
      await updateTask(task.id, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${msg}` });
    } else {
      await updateTask(task.id, { error_message: `تعذر الوصول لخدمة الدمج: ${msg}` });
    }
    return { task: (await getTask(taskId))! };
  }

  fireProcessInBackground(jobId, task.id);

  // 4) نافذة الانتظار
  const waitSeconds = clampWait(args.wait_seconds, 60);
  return await waitMergeWindow(taskId, jobId, waitSeconds, sink);
}

/** نفّذ POST .../process خلفيًا وبمرة واحدة فقط — محمي بقفل الذاكرة */
function fireProcessInBackground(jobId: string, taskId: string): void {
  void (async () => {
    if (processInFlight.has(jobId)) return; // لا تزامن مع get_task
    processInFlight.add(jobId);
    try {
      const st = await mergerProcess(jobId);
      if (st.state === "completed") {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl!]), error_message: null });
      } else if (st.state === "failed") {
        await updateTask(taskId, { status: "failed", error_message: st.error ?? "فشل الدمج" });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // أثناء نافذة الانتظار سنستعلم GET /api/jobs/{id} أيضًا — لا نحسم هنا على أخطاء شبكتنا المؤقتة
      await updateTask(taskId, { error_message: `عملية الدمج: ${msg}` });
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** نافذة انتظار الدمج: استعلام كل 3 ثوانٍ + كتابة فورية في Turso + بث تقدم */
async function waitMergeWindow(taskId: string, jobId: string, waitSeconds: number, sink: ProgressSink): Promise<{ task: TaskRow | null }> {
  const deadline = Date.now() + waitSeconds * 1000;
  let task = (await getTask(taskId))!;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    task = (await getTask(taskId))!;
    if (!task) break;
    if (task.status === "completed" || task.status === "failed") break;

    let st: MergerStatus;
    try {
      st = await mergerGetJob(jobId);
    } catch (e: unknown) {
      // خطأ شبكتنا نحن = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
      await updateTask(taskId, { error_message: `استعلام خدمة الدمج: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    if (st.state === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl!]), error_message: null });
      await sink.sendProgress(100, 100, "اكتمل الدمج");
      break;
    }
    if (st.state === "failed") {
      await updateTask(taskId, { status: "failed", error_message: st.error ?? "فشل الدمج" });
      break;
    }
    await updateTask(taskId, { progress: Math.max(task.progress, st.progress), status: "processing", error_message: null });
    await sink.sendProgress(Math.max(task.progress, st.progress), 100, "قيد الدمج…");
    task = (await getTask(taskId))!;
  }
  return { task: (await getTask(taskId))! };
}

/** refreshMergeTask: حدّث من GET /api/jobs/{id}؛ نفّذ process إن لم يُنفذ بعد؛ 404 → فشل نهائي */
export async function refreshMergeTask(task: TaskRow, sink: ProgressSink): Promise<TaskRow> {
  const jobId = task.provider_task_id;
  if (!jobId) {
    // لم تُنشأ لدى الخدمة بعد (شبكتنا كانت مقطوعة) → أعد المحاولة من البداية
    const params = safeParseInput(task) as { urls?: string[] };
    if (Array.isArray(params.urls) && params.urls.length >= 2) {
      try {
        const created = await mergerCreateJob(params.urls);
        await updateTask(task.id, { provider_task_id: created.jobId, error_message: null });
        fireProcessInBackground(created.jobId, task.id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof ProviderError && e.status !== 0) {
          await updateTask(task.id, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${msg}` });
        }
      }
    } else {
      await updateTask(task.id, { status: "failed", error_message: "مهمة الدمج بلا روابط صالحة" });
    }
    return (await getTask(task.id))!;
  }

  try {
    // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (قفل الذاكرة يمنع التزامن)
    if (task.status !== "completed" && !processInFlight.has(jobId)) {
      fireProcessInBackground(jobId, task.id);
    }
    const st = await mergerGetJob(jobId);
    if (st.state === "completed") {
      await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl!]), error_message: null });
    } else if (st.state === "failed") {
      await updateTask(task.id, { status: "failed", error_message: st.error ?? "فشل الدمج" });
    } else {
      await updateTask(task.id, { progress: Math.max(task.progress, st.progress), status: "processing", error_message: null });
      await sink.sendProgress(Math.max(task.progress, st.progress), 100, "قيد الدمج…");
    }
  } catch {
    // خطأ شبكتنا = مؤقت — تبقى processing وتتحدث في الاستدعاء القادم
  }
  return (await getTask(task.id))!;
}

/* -------------------------------- أدوات عامة -------------------------------- */

function clampWait(v: number | undefined, dflt: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) return dflt;
  return Math.max(0, Math.min(240, Math.floor(v)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { WAITING_FOR_KEYS_MSG, MERGER_BASE };
