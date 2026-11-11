"use client";

/**
 * لوحة الإدارة العربية RTL — صفحة واحدة:
 *  هيدر (حالة /api/health) + ثلاث بطاقات:
 *  أ) مدير المفاتيح  ب) لوحة المهام (تحديث تلقائي كل ~5 ثوانٍ)  ج) ربط السيرفر
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- الأنواع ------------------------------- */

interface PublicKey {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
}

interface DashboardTask {
  id: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  provider: string | null;
  prompt: string;
  urls: string[];
  error: string | null;
  attempts: number;
  createdAt: string | null;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

/* ------------------------------ أدوات صغيرة ------------------------------ */

function statusBadge(status: string): { text: string; cls: string } {
  switch (status) {
    case "active":
      return { text: "نشط", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
    case "exhausted":
      return { text: "مستنزف", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
    case "disabled":
      return { text: "معطّل", cls: "bg-slate-500/15 text-slate-300 border-slate-500/30" };
    case "completed":
      return { text: "مكتملة", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
    case "failed":
      return { text: "فاشلة", cls: "bg-red-500/15 text-red-300 border-red-500/30" };
    case "pending":
    case "processing":
      return { text: "قيد المعالجة", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
    default:
      return { text: status, cls: "bg-slate-500/15 text-slate-300 border-slate-500/30" };
  }
}

function typeLabel(type: string): string {
  return type === "image" ? "صورة" : type === "video" ? "فيديو" : type === "merge" ? "دمج" : type;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso.endsWith("Z") || iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `قبل ${s} ثانية`;
  if (s < 3600) return `قبل ${Math.floor(s / 60)} دقيقة`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} ساعة`;
  return `قبل ${Math.floor(s / 86400)} يوم`;
}

function CopyButton({ text, label = "نسخ" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* المتصفح منع النسخ */
        }
      }}
      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 transition"
    >
      {copied ? "تم النسخ ✓" : label}
    </button>
  );
}

const cardCls = "rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-black/20 backdrop-blur";

/* -------------------------------- الصفحة -------------------------------- */

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<PublicKey[]>([]);
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keysMsg, setKeysMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [origin, setOrigin] = useState("");
  const keysEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // قراءة الأصل بعد التثبيت (خارج جسم الـ effect المباشر)
    const id = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(id);
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys", { cache: "no-store" });
      const d = await r.json();
      setKeys(d.keys ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const d = await r.json();
      setTasks(d.tasks ?? []);
      if (d.stats) setStats(d.stats);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // التحميل الأولي بعد التثبيت ثم تحديث دوري
    const initial = window.setTimeout(() => {
      void loadHealth();
      void loadKeys();
      void loadTasks();
    }, 0);
    const t1 = setInterval(() => void loadTasks(), 5000); // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t2 = setInterval(() => void loadHealth(), 10000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadHealth, loadKeys, loadTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setKeysMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const d = await r.json();
      if (!r.ok) {
        setKeysMsg({ kind: "err", text: d.error ?? "فشل إضافة المفتاح" });
        return;
      }
      setKeys(d.keys ?? []);
      setApiKey("");
      setLabel("");
      setKeysMsg({ kind: "ok", text: "تم إضافة المفتاح بنجاح — سيُجرَّب أولًا في الترتيب التسلسلي." });
    } catch {
      setKeysMsg({ kind: "err", text: "تعذر الاتصال بالخادم" });
    }
  }

  async function patchKey(id: string, status: "active" | "disabled") {
    const r = await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (r.ok) {
      const d = await r.json();
      setKeys(d.keys ?? []);
    }
  }

  async function deleteKey(id: string) {
    const r = await fetch(`/api/keys/${id}`, { method: "DELETE" });
    if (r.ok) {
      const d = await r.json();
      setKeys(d.keys ?? []);
    }
  }

  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";

  const snippets = useMemo(() => {
    const auth = health?.authRequired
      ? `,\n      "headers": { "Authorization": "Bearer ${"<MCP_ACCESS_TOKEN>"}" }`
      : "";
    return {
      chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
    };
  }, [mcpUrl, health?.authRequired]);

  const toolChips = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي" },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن" },
    { name: "merge_videos", desc: "دمج عدة مقاطع بالترتيب" },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها" },
    { name: "list_media", desc: "استرجاع الوسائط المخزنة" },
  ];

  const dbOk = health?.database === "turso-connected";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      {/* ================================ الهيدر ================================ */}
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold tracking-tight">MCP Media Generator</h1>
            <p className="text-xs text-slate-400 mt-1">خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة الإدارة العربية</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium ${
                dbOk ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-red-500/15 text-red-300 border-red-500/30"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${dbOk ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
              {dbOk ? "Turso متصل" : "غير متصل"}
            </span>
            {health && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-medium ${
                  health.merger.healthy
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                }`}
              >
                خدمة الدمج: {health.merger.healthy ? "جاهزة" : "غير متاحة"}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 grid gap-6">
        {/* ============================ أ) مدير المفاتيح ============================ */}
        <section className={cardCls} aria-label="مدير المفاتيح">
          <h2 className="text-lg font-bold mb-1">أ) مدير المفاتيح</h2>
          <p className="text-xs text-slate-400 leading-6 mb-4">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي
            خطأ أو نفاد رصيد دون توقف.
          </p>

          <form onSubmit={addKey} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <label className="grid gap-1.5 text-xs">
              <span className="text-slate-300">المزود</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="h-10 rounded-lg border border-slate-700 bg-slate-800/80 px-3 text-sm outline-none focus:border-sky-500"
              >
                <option value="kie">kie.ai</option>
                <option value="cometapi">CometAPI</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-xs">
              <span className="text-slate-300">تسمية (اختياري)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="مثال: الحساب الأول"
                className="h-10 rounded-lg border border-slate-700 bg-slate-800/80 px-3 text-sm outline-none focus:border-sky-500"
              />
            </label>
            <label className="grid gap-1.5 text-xs sm:col-span-2">
              <span className="text-slate-300">مفتاح API</span>
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="ألصق المفتاح هنا"
                required
                dir="ltr"
                className="h-10 rounded-lg border border-slate-700 bg-slate-800/80 px-3 text-sm outline-none focus:border-sky-500"
              />
            </label>
            <button
              type="submit"
              className="h-10 sm:col-span-4 rounded-lg bg-sky-500/90 text-slate-950 font-semibold text-sm hover:bg-sky-400 transition"
            >
              إضافة المفتاح
            </button>
          </form>
          {keysMsg && (
            <p className={`mt-3 text-xs ${keysMsg.kind === "ok" ? "text-emerald-300" : "text-red-300"}`} role="status">
              {keysMsg.text}
            </p>
          )}

          <div className="mt-5 max-h-96 overflow-y-auto rounded-xl border border-slate-800" style={{ scrollbarWidth: "thin" }}>
            {keys.length === 0 ? (
              <p className="p-4 text-sm text-slate-400">لا توجد مفاتيح بعد — أضف أول مفتاح أعلاه.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-slate-400 bg-slate-800/60">
                  <tr className="text-right">
                    <th className="p-3 font-medium">المفتاح</th>
                    <th className="p-3 font-medium">المزود</th>
                    <th className="p-3 font-medium">الحالة</th>
                    <th className="p-3 font-medium">استخدام/نجاح/فشل</th>
                    <th className="p-3 font-medium">آخر خطأ</th>
                    <th className="p-3 font-medium">أضيف</th>
                    <th className="p-3 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const b = statusBadge(k.status);
                    return (
                      <tr key={k.id} className="border-t border-slate-800 align-top">
                        <td className="p-3 font-mono" dir="ltr">{k.maskedKey}</td>
                        <td className="p-3">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</td>
                        <td className="p-3">
                          <span className={`rounded-full border px-2 py-0.5 ${b.cls}`}>{b.text}</span>
                        </td>
                        <td className="p-3 font-mono">{k.usageCount}/{k.successCount}/{k.failCount}</td>
                        <td className="p-3 max-w-52 truncate text-amber-300/90" title={k.lastError ?? ""}>{k.lastError ?? "—"}</td>
                        <td className="p-3 text-slate-400">{timeAgo(k.createdAt)}</td>
                        <td className="p-3">
                          <div className="flex gap-2">
                            {k.status === "disabled" ? (
                              <button onClick={() => void patchKey(k.id, "active")} className="px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25">
                                تنشيط
                              </button>
                            ) : (
                              <button onClick={() => void patchKey(k.id, "disabled")} className="px-2 py-1 rounded-md bg-slate-500/15 text-slate-300 border border-slate-500/30 hover:bg-slate-500/25">
                                تعطيل
                              </button>
                            )}
                            <button onClick={() => void deleteKey(k.id)} className="px-2 py-1 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25">
                              حذف
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div ref={keysEndRef} />
          </div>
        </section>

        {/* ============================ ب) لوحة المهام ============================ */}
        <section className={cardCls} aria-label="لوحة المهام">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h2 className="text-lg font-bold">ب) لوحة المهام</h2>
            <span className="text-[11px] text-slate-500">تتحدث تلقائيًا كل ~5 ثوانٍ</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "الإجمالي", v: stats.total, cls: "text-slate-200" },
              { label: "مكتملة", v: stats.completed, cls: "text-emerald-300" },
              { label: "فاشلة", v: stats.failed, cls: "text-red-300" },
              { label: "جارية", v: stats.processing, cls: "text-sky-300" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-800 bg-slate-800/40 p-4 text-center">
                <div className={`text-2xl font-bold ${s.cls}`}>{s.v}</div>
                <div className="text-xs text-slate-400 mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          <div className="max-h-96 overflow-y-auto grid gap-3" style={{ scrollbarWidth: "thin" }}>
            {tasks.length === 0 ? (
              <p className="text-sm text-slate-400">لا توجد مهام بعد — تُعرض هنا فور استخدام الأدوات من عميل MCP.</p>
            ) : (
              tasks.map((t) => {
                const b = statusBadge(t.status);
                return (
                  <article key={t.id} className="rounded-xl border border-slate-800 bg-slate-800/30 p-4">
                    <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-slate-700/60 px-2 py-0.5 font-medium">{typeLabel(t.type)}</span>
                        <span className={`rounded-full border px-2 py-0.5 ${b.cls}`}>{b.text}</span>
                        <span className="text-slate-400 font-mono" dir="ltr">{t.model}</span>
                      </div>
                      <span className="text-slate-500">{timeAgo(t.createdAt)}</span>
                    </div>
                    {t.prompt && <p className="mt-2 text-xs text-slate-300 line-clamp-2">{t.prompt}</p>}
                    <div className="mt-3 h-2 rounded-full bg-slate-700/60 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${t.status === "failed" ? "bg-red-500" : t.status === "completed" ? "bg-emerald-500" : "bg-sky-500"}`}
                        style={{ width: `${t.status === "completed" ? 100 : t.progress}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-400">
                      <span className="font-mono" dir="ltr">task_id: {t.id}</span>
                      <span>
                        {t.provider ? `المزود: ${t.provider}` : "بانتظار مفتاح"} · محاولات: {t.attempts}
                      </span>
                    </div>
                    {t.urls.length > 0 && (
                      <div className="mt-2 flex gap-2 flex-wrap">
                        {t.urls.map((u, i) => (
                          <a
                            key={i}
                            href={u}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-1 text-[11px] hover:bg-emerald-500/25"
                          >
                            فتح النتيجة {t.urls.length > 1 ? i + 1 : ""} ↗
                          </a>
                        ))}
                      </div>
                    )}
                    {t.error && <p className="mt-2 text-[11px] text-red-300">الخطأ: {t.error}</p>}
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* ============================ ج) ربط السيرفر ============================ */}
        <section className={cardCls} aria-label="ربط السيرفر">
          <h2 className="text-lg font-bold mb-4">ج) ربط السيرفر</h2>

          <div className="flex items-center gap-2 flex-wrap mb-5">
            <code className="flex-1 min-w-64 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm font-mono" dir="ltr">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} label="نسخ الرابط" />
          </div>

          <div className="flex gap-2 mb-3 text-xs">
            {[
              { id: "chatgpt", t: "ChatGPT / GPT Agents" },
              { id: "claude", t: "Claude Desktop" },
              { id: "cursor", t: "Cursor / Windsurf / Cline" },
            ].map((x) => (
              <button
                key={x.id}
                onClick={() => setTab(x.id as typeof tab)}
                className={`rounded-lg px-3 py-2 border transition ${
                  tab === x.id ? "bg-sky-500/20 text-sky-200 border-sky-500/40" : "bg-slate-800/60 text-slate-300 border-slate-700 hover:bg-slate-800"
                }`}
              >
                {x.t}
              </button>
            ))}
          </div>

          <div className="relative">
            <pre className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-[12px] font-mono overflow-x-auto" dir="ltr">
              {snippets[tab]}
            </pre>
            <div className="absolute top-2 left-2">
              <CopyButton text={snippets[tab]} />
            </div>
          </div>

          {tab === "chatgpt" && (
            <p className="mt-2 text-xs text-slate-400">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضَع الرابط في «Server URL».
            </p>
          )}
          {tab === "claude" && (
            <p className="mt-2 text-xs text-slate-400">
              انسخ المحتوى إلى ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.
            </p>
          )}
          {tab === "cursor" && (
            <p className="mt-2 text-xs text-slate-400">
              انسخ المحتوى إلى mcp.json في Cursor / Windsurf / Cline.
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            {toolChips.map((c) => (
              <span key={c.name} className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs" title={c.desc}>
                <code dir="ltr" className="font-mono text-sky-300">{c.name}</code>
                <span className="text-slate-400"> — {c.desc}</span>
              </span>
            ))}
          </div>

          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200 leading-6">
            الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
            المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا
            تنقطع العملية.
          </p>
        </section>
      </main>

      <footer className="mt-auto border-t border-slate-800 py-4 text-center text-[11px] text-slate-500">
        MCP Media Generator v1.2.0 — مفاتيحك مخفية دائمًا في كل الاستجابات · لا يُنزَّل أي ملف وسائط على السيرفر
      </footer>
    </div>
  );
}
