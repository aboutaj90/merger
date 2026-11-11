/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحمّل .env يدويًا
 * - يحلّل المسارات الديناميكية (/api/jobs/<id> إلخ) ويضعها في req.query مثل Vercel
 * - يخدم واجهة public/index.html على الجذر
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

/* ------------------------- تحميل .env يدويًا ------------------------- */
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const jobsApi = require("./api/jobs");
const jobsIdApi = require("./api/jobs/[id]");
const processApi = require("./api/jobs/[id]/process");
const videoApi = require("./api/jobs/[id]/video");
const uploadApi = require("./api/upload");
const configApi = require("./api/config");
const cronApi = require("./api/cron");

const PORT = Number(process.env.PORT || 3030);

/** تحميل جسم الطلب إلى req.bodyRaw للتمرير للدوال (محاكاة سلوك Vercel مع الأجسام الثنائية) */
function prepareRequest(req, pathname, query) {
  req.query = query;
  req.url = pathname + (Object.keys(query).length ? "?" : "") + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname || "/");
  const query = { ...parsed.query };

  // CORS مفتوح + دعم preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ضع معاملات الاستعلام في req.query لكل المسارات (كما تفعل Vercel)
    req.query = query;

    // /api/jobs
    if (pathname === "/api/jobs") {
      if (req.method === "POST") return void (await jobsApi.POST(req, res));
      if (req.method === "GET") return void (await jobsApi.GET(req, res));
      return fail405(res);
    }
    // /api/jobs/<id>
    if (/^\/api\/jobs\/[^/]+$/.test(pathname)) {
      query.id = pathname.split("/")[3];
      prepareRequest(req, pathname, query);
      if (req.method === "GET") return void (await jobsIdApi.GET(req, res));
      if (req.method === "DELETE") return void (await jobsIdApi.DELETE(req, res));
      return fail405(res);
    }
    // /api/jobs/<id>/process
    if (/^\/api\/jobs\/[^/]+\/process$/.test(pathname)) {
      query.id = pathname.split("/")[3];
      prepareRequest(req, pathname, query);
      if (req.method === "POST") return void (await processApi.POST(req, res));
      return fail405(res);
    }
    // /api/jobs/<id>/video
    if (/^\/api\/jobs\/[^/]+\/video$/.test(pathname)) {
      query.id = pathname.split("/")[3];
      prepareRequest(req, pathname, query);
      if (req.method === "GET") return void (await videoApi.GET(req, res));
      return fail405(res);
    }
    // /api/upload
    if (pathname === "/api/upload") {
      if (req.method === "POST") return void (await uploadApi.POST(req, res));
      return fail405(res);
    }
    // /api/config
    if (pathname === "/api/config") {
      if (req.method === "GET") return void (await configApi.GET(req, res));
      return fail405(res);
    }
    // /api/cron
    if (pathname === "/api/cron") {
      if (req.method === "GET") return void (await cronApi.GET(req, res));
      return fail405(res);
    }

    // الواجهة الثابتة
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const file = path.join(__dirname, "public", "index.html");
      const html = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
      res.end(html);
      return;
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "المسار غير موجود" }));
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "خطأ داخلي في خادم التطوير: " + e.message }));
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
});

function fail405(res) {
  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, POST, DELETE" });
  res.end(JSON.stringify({ error: "طريقة HTTP غير مسموحة لهذا المسار" }));
}

server.listen(PORT, () => {
  console.log(`[merger-site] خادم التطوير يعمل على http://localhost:${PORT}`);
});
