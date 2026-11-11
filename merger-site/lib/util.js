/**
 * أدوات مشتركة: متغيرات البيئة، الاستجابات، حدود الخدمة، تنظيف /tmp
 */
"use strict";

const env = process.env;

const LIMITS = {
  maxSources: Number(env.MAX_SOURCES || 10),
  sourceMaxBytes: Math.floor(Number(env.SOURCE_MAX_MB || 200) * 1024 * 1024),
  outputMaxBytes: Math.floor(Number(env.OUTPUT_MAX_MB || 150) * 1024 * 1024),
  maxTotalDurationSec: Number(env.MAX_TOTAL_DURATION_SEC || 600),
  uploadChunkBytes: 4 * 1024 * 1024, // حد حجم الطلب في Vercel ≈ 4.5MB — نرفع بأجزاء 4MB
  chunkRowBytes: 2 * 1024 * 1024, // كل صف Blob في Turso ≤ 2MB (حد HTTP)
  readPageRows: 8, // قراءة تدفقية بصفحات من 8 صفوف
  retentionHours: 24,
  version: "1.0.0",
};

const RETENTION_MS = LIMITS.retentionHours * 60 * 60 * 1000;

/** استجابة JSON موحدة */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

/** خطأ بصيغة {"error":"..."} برسائل عربية واضحة وكود صحيح */
function fail(res, status, message) {
  json(res, status, { error: message });
}

/** قراءة جسم JSON من الطلب — يعيد null عند التلف */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        aborted = true;
        resolve({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({ ok: true, body: {} });
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false });
      }
    });
    req.on("error", () => resolve({ ok: false }));
  });
}

/** قراءة جسم ثنائي (رفع الأجزاء) بحد أقصى */
function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        resolve({ ok: false, tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (total === 0 && chunks.length === 0) return resolve({ ok: false, empty: true });
      resolve({ ok: true, buffer: Buffer.concat(chunks) });
    });
    req.on("error", () => resolve({ ok: false }));
  });
}

/** تنظيف ملفات /tmp المؤقتة (لا نظام ملفات دائم — /tmp فقط أثناء المعالجة) */
function tmpCleanup(paths) {
  const fs = require("fs");
  for (const p of paths) {
    try {
      fs.rmSync(p, { force: true, recursive: true });
    } catch {
      /* تجاهل */
    }
  }
}

function randomId(len = 11) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const bytes = require("crypto").randomBytes(len);
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function newExpiresAt() {
  return new Date(Date.now() + RETENTION_MS).toISOString();
}

/** مقنع أخطاء غير متوقعة في دوال serverless — لا انهيار استجابة أبدًا */
function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error("[merger] unexpected error:", e && e.message);
      if (!res.headersSent) fail(res, 500, "خطأ داخلي غير متوقع: " + (e && e.message ? String(e.message).slice(0, 200) : "unknown"));
      else try { res.end(); } catch { /* ignore */ }
    }
  };
}

function publicBase(req) {
  // في Vercel نستخدم الرؤوس الرسمية، ومحليًا نستخدم المضيف الوارد
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

module.exports = { LIMITS, RETENTION_MS, json, fail, readJsonBody, readRawBody, tmpCleanup, randomId, newExpiresAt, guard, publicBase };
