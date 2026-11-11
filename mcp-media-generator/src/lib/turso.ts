/**
 * طبقة قاعدة البيانات — Turso عبر HTTP (libSQL client)
 * عميل واحد معاد استخدامه + إنشاء المخطط عند أول وصول (بلا migrations)
 */
import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

/** عميل Turso واحد (يتصل عبر HTTP — متوافق مع Vercel serverless) */
export function getTurso(): Client {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    });
  }
  return _client;
}

/** إنشاء الجداول عند أول وصول — CREATE TABLE IF NOT EXISTS فلا حاجة لأداة migrations */
let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getTurso();
      await db.batch(
        [
          {
            sql: `CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            provider TEXT,
            provider_task_id TEXT,
            key_id TEXT,
            model TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT DEFAULT '',
            params_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            result_urls_json TEXT,
            error_message TEXT,
            attempts_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT
          )`,
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            usage_count INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            fail_count INTEGER DEFAULT 0,
            last_used_at TEXT,
            last_checked_at TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
        },
      ]);
    })().catch((e) => {
      schemaReady = null; // اسمح بإعادة المحاولة عند الطلب التالي
      throw e;
    });
  }
  return schemaReady;
}

/** فحص صحة قاعدة البيانات بـ SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1 AS one");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

/* ----------------------------- أنواع البيانات ----------------------------- */

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string | null;
}

/** محاولة واحدة مسجلة داخل attempts_json */
export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/* --------------------------- عمليات المهام tasks --------------------------- */

function mapTask(r: Record<string, unknown>): TaskRow {
  return r as unknown as TaskRow;
}

export async function insertTask(t: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]')`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1",
    args: [id],
  });
  return r.rows.length ? mapTask(r.rows[0] as unknown as Record<string, unknown>) : null;
}

/** تحديث جزئي للمهمة — يضيف attempt إلى attempts_json ويضبط updated_at/completed_at تلقائيًا */
export async function updateTask(
  id: string,
  patch: {
    provider?: string | null;
    provider_task_id?: string | null;
    key_id?: string | null;
    status?: string;
    progress?: number;
    result_urls_json?: string | null;
    error_message?: string | null;
    append_attempt?: TaskAttempt;
    clear_provider?: boolean;
  }
): Promise<void> {
  await ensureSchema();
  const db = getTurso();

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null)[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed" || patch.status === "failed") {
      sets.push("completed_at = datetime('now')");
    } else {
      sets.push("completed_at = NULL");
    }
  }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls_json !== undefined) { sets.push("result_urls_json = ?"); args.push(patch.result_urls_json); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.append_attempt) {
    // إلحاق ذرّي عبر json_insert — لا قراءة-ثم-كتابة فلا يُفقد أي محاولة عند تزامن أو توقف عابر للقراءة
    sets.push("attempts_json = json_insert(COALESCE(attempts_json, json('[]')), '$[#]', json(?))");
    args.push(JSON.stringify(patch.append_attempt));
  }

  args.push(id);
  await db.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit = 10,
  filter?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: string[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(String(limit));
  const r = await getTurso().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((x) => mapTask(x as unknown as Record<string, unknown>));
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getTurso().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

/* -------------------------- عمليات المفاتيح api_keys -------------------------- */

function mapKey(r: Record<string, unknown>): ApiKeyRow {
  const k = r as unknown as ApiKeyRow;
  return { ...k, usage_count: Number(k.usage_count ?? 0), success_count: Number(k.success_count ?? 0), fail_count: Number(k.fail_count ?? 0) };
}

/** جلب مفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم (أول مفتاح أُضيف أولًا) */
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((x) => mapKey(x as unknown as Record<string, unknown>));
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((x) => mapKey(x as unknown as Record<string, unknown>));
}

export async function getKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  return r.rows.length ? mapKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function findKeyByValue(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return r.rows.length ? mapKey(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function insertApiKey(k: {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function updateApiKey(
  id: string,
  patch: { status?: string; last_error?: string | null }
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.last_error !== undefined) { sets.push("last_error = ?"); args.push(patch.last_error); }
  if (!sets.length) return;
  args.push(id);
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل) — مع تصنيف نتيجة الاستخدام */
export async function bumpKeyUsage(
  id: string,
  outcome: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  await ensureSchema();
  const db = getTurso();
  const cur = await db.execute({
    sql: "SELECT usage_count, success_count, fail_count FROM api_keys WHERE id = ?",
    args: [id],
  });
  if (!cur.rows.length) return;
  const usage = Number(cur.rows[0].usage_count ?? 0) + 1;
  const ok = Number(cur.rows[0].success_count ?? 0) + (outcome.ok ? 1 : 0);
  const fail = Number(cur.rows[0].fail_count ?? 0) + (outcome.ok ? 0 : 1);
  await db.execute({
    sql: `UPDATE api_keys
          SET usage_count = ?, success_count = ?, fail_count = ?, last_used_at = datetime('now'),
              last_checked_at = datetime('now'),
              last_error = ?
          WHERE id = ?`,
    args: [usage, ok, fail, outcome.ok ? null : (outcome.error ?? outcome.errorClass ?? "unknown"), id],
  });
}

export async function deleteApiKey(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}
