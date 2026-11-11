/**
 * طبقة قاعدة البيانات — Turso (libSQL) تخزن كل شيء: المهام، أجزاء المصادر، والفيديو الناتج (Blobs).
 * لا S3 ولا خدمات خارجية. جداول تنشأ بـ CREATE TABLE IF NOT EXISTS مع مفتاح أساسي مركب.
 */
"use strict";

const { createClient } = require("@libsql/client");

let _client = null;

function db() {
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

let schemaReady = null;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db().batch(
        [
          {
            sql: `CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL DEFAULT 'queued',
              progress INTEGER DEFAULT 0,
              sources_json TEXT NOT NULL DEFAULT '[]',
              error TEXT,
              result_json TEXT,
              expires_at TEXT NOT NULL,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            )`,
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS sources (
              job_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              kind TEXT NOT NULL,
              url TEXT,
              name TEXT,
              mime TEXT,
              size INTEGER,
              PRIMARY KEY (job_id, seq)
            )`,
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS source_chunks (
              job_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              chunk_idx INTEGER NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY (job_id, seq, chunk_idx)
            )`,
          },
          {
            sql: `CREATE TABLE IF NOT EXISTS output_chunks (
              job_id TEXT NOT NULL,
              chunk_idx INTEGER NOT NULL,
              data BLOB NOT NULL,
              PRIMARY KEY (job_id, chunk_idx)
            )`,
          },
        ],
        "write"
      );
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/* --------------------------------- المهام --------------------------------- */

async function insertJob(job) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, expires_at) VALUES (?, ?, 0, ?, ?)`,
    args: [job.id, job.status, JSON.stringify(job.sources), job.expires_at],
  });
}

async function getJob(id) {
  await ensureSchema();
  const r = await db().execute({ sql: `SELECT * FROM jobs WHERE id = ? LIMIT 1`, args: [id] });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  let sources = [];
  try {
    sources = JSON.parse(String(row.sources_json || "[]"));
  } catch { /* ignore */ }
  let result = null;
  try {
    result = row.result_json ? JSON.parse(String(row.result_json)) : null;
  } catch { /* ignore */ }
  return {
    id: String(row.id),
    status: String(row.status),
    progress: Number(row.progress || 0),
    sources,
    error: row.error ? String(row.error) : null,
    result,
    expires_at: String(row.expires_at),
    created_at: row.created_at ? String(row.created_at) : null,
  };
}

async function listJobs(limit = 20) {
  await ensureSchema();
  const r = await db().execute({ sql: `SELECT id, status, progress, expires_at, created_at FROM jobs ORDER BY created_at DESC LIMIT ?`, args: [String(limit)] });
  return r.rows.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    progress: Number(row.progress || 0),
    expires_at: String(row.expires_at),
    created_at: row.created_at ? String(row.created_at) : null,
  }));
}

async function updateJob(id, patch) {
  await ensureSchema();
  const sets = ["updated_at = datetime('now')"];
  const args = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.error !== undefined) { sets.push("error = ?"); args.push(patch.error); }
  if (patch.result_json !== undefined) { sets.push("result_json = ?"); args.push(patch.result_json); }
  args.push(id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

/** حذف فوري شامل: jobs + sources + source_chunks + output_chunks في batch واحد */
async function deleteJobCascade(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
    ],
    "write"
  );
}

/** حذف المهام المنتهية (تنظيف كسول + /api/cron) — يعيد عدد المهام المحذوفة */
async function deleteExpiredJobs() {
  await ensureSchema();
  const now = new Date().toISOString();
  const r = await db().execute({
    sql: `SELECT id FROM jobs WHERE expires_at < ?`,
    args: [now],
  });
  let count = 0;
  for (const row of r.rows) {
    await deleteJobCascade(String(row.id));
    count++;
  }
  return count;
}

/* ------------------------------- المصادر والأجزاء ------------------------------- */

async function insertSource(jobId, seq, src) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [jobId, seq, src.kind, src.url || null, src.name || null, src.mime || null, src.size === undefined ? null : src.size],
  });
}

async function getSources(jobId) {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT seq, kind, url, name, mime, size FROM sources WHERE job_id = ? ORDER BY seq ASC`,
    args: [jobId],
  });
  return r.rows.map((row) => ({
    seq: Number(row.seq),
    kind: String(row.kind),
    url: row.url ? String(row.url) : null,
    name: row.name ? String(row.name) : null,
    mime: row.mime ? String(row.mime) : null,
    size: row.size === null || row.size === undefined ? null : Number(row.size),
  }));
}

async function insertSourceChunk(jobId, seq, chunkIdx, buffer) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO source_chunks (job_id, seq, chunk_idx, data) VALUES (?, ?, ?, ?)`,
    args: [jobId, seq, chunkIdx, buffer],
  });
}

async function countSourceChunks(jobId, seq) {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes FROM source_chunks WHERE job_id = ? AND seq = ?`,
    args: [jobId, seq],
  });
  return { count: Number(r.rows[0].n || 0), bytes: Number(r.rows[0].bytes || 0) };
}

/** قراءة كل أجزاء مصدر مرفوع بالترتيب إلى ملف محلي (/tmp) — تحقق من الحجم أثناء التجميع */
async function assembleSourceToFile(jobId, seq, destPath, maxBytes) {
  const fs = require("fs");
  await ensureSchema();
  const pageRows = 8;
  let offset = 0;
  let total = 0;
  const fd = fs.openSync(destPath, "w");
  try {
    for (;;) {
      const r = await db().execute({
        sql: `SELECT chunk_idx, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_idx ASC LIMIT ? OFFSET ?`,
        args: [jobId, seq, String(pageRows), String(offset)],
      });
      if (!r.rows.length) break;
      for (const row of r.rows) {
        const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        total += buf.length;
        if (total > maxBytes) throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1048576)}MB)`);
        fs.writeFileSync(fd, buf);
      }
      if (r.rows.length < pageRows) break;
      offset += pageRows;
    }
  } finally {
    fs.closeSync(fd);
  }
  return total;
}

async function insertOutputChunk(jobId, chunkIdx, buffer) {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO output_chunks (job_id, chunk_idx, data) VALUES (?, ?, ?)`,
    args: [jobId, chunkIdx, buffer],
  });
}

/** تقرأ المخرج تدفقيًا بصفحات من 8 صفوف — تمرر كل جزء إلى onChunk ثم تحذف الصفوف المقروءة */
async function streamOutput(jobId, onChunk) {
  await ensureSchema();
  const pageRows = 8;
  let offset = 0;
  for (;;) {
    const r = await db().execute({
      sql: `SELECT chunk_idx, data FROM output_chunks WHERE job_id = ? ORDER BY chunk_idx ASC LIMIT ? OFFSET ?`,
      args: [jobId, String(pageRows), String(offset)],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
      await onChunk(buf);
    }
    if (r.rows.length < pageRows) break;
    offset += pageRows;
  }
}

async function countOutputBytes(jobId) {
  await ensureSchema();
  const r = await db().execute({
    sql: `SELECT COALESCE(SUM(LENGTH(data)),0) AS bytes FROM output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  return Number(r.rows[0].bytes || 0);
}

/** بعد نجاح الدمج احذف source_chunks — الناتج فقط هو المطلوب */
async function deleteSourceChunks(jobId) {
  await ensureSchema();
  await db().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

module.exports = {
  db,
  ensureSchema,
  insertJob,
  getJob,
  listJobs,
  updateJob,
  deleteJobCascade,
  deleteExpiredJobs,
  insertSource,
  getSources,
  insertSourceChunk,
  countSourceChunks,
  assembleSourceToFile,
  insertOutputChunk,
  streamOutput,
  countOutputBytes,
  deleteSourceChunks,
};
