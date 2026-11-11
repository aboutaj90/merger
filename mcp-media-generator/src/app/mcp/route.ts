/**
 * خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP عبر SDK الرسمية.
 * لا JSON-RPC يدوي إطلاقًا.
 *
 * لماذا WebStandardStreamableHTTPServerTransport؟ في SDK 1.32 النقل النودجي
 * StreamableHTTPServerTransport هو مجرد غلاف يحوّل req/res إلى Web Request ويُفوّض
 * إلى هذا النقل المعياري داخليًا — وفي Next.js App Router يستقبل route handler أصلًا
 * Web Request ويعيد Web Response، فهذا هو المسار الرسمي المباشر (بلا تلوّف محوّلات
 * req/res الهشة)، ويحافظ على كل سلوك المواصفة: جلسات mcp-session-id، تيار SSE،
 * و DELETE لإنهاء الجلسة.
 *
 * - إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
 * - الجلسات تُدار في الذاكرة (خريطة sessionId → transport) مع تنظيف تلقائي.
 * - وضع stateless اختياري عبر MCP_STATELESS=1 لبيئات serverless متعددة النسخ.
 */
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer, SERVER_INFO } from "@/lib/mcp";
import { dbHealthy } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// انتظار التوليد قد يمتد دقائق — ارفع حد المدة (Vercel: حسب الخطة)
export const maxDuration = 300;

const STATELESS = process.env.MCP_STATELESS === "1";
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";

interface SessionEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  lastAccess: number;
}
const sessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 30 * 60 * 1000;

/* ------------------------------ إدارة الجلسات ------------------------------ */

function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      sessions.delete(id);
      void entry.transport.close().catch(() => {});
    }
  }
}

/** إنشاء زوج server+transport جديد — الجلسة تُسجَّل تلقائيًا عند اكتمال التهيئة */
function createSessionPair(): WebStandardStreamableHTTPServerTransport {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: STATELESS ? undefined : () => randomUUID(),
    enableJsonResponse: false, // SSE مطلوب لبث progress notifications
    onsessioninitialized: (id) => {
      if (!STATELESS) sessions.set(id, { transport, lastAccess: Date.now() });
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
    void server.close().catch(() => {});
  };
  void server.connect(transport);
  return transport;
}

/* -------------------------------- المعالج -------------------------------- */

function jsonError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  // توثيق اختياري: Bearer token على /mcp بالكامل
  if (ACCESS_TOKEN) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${ACCESS_TOKEN}`) {
      return jsonError(401, -32001, "Unauthorized: missing or invalid bearer token");
    }
  }

  const method = request.method;
  const sessionId = request.headers.get("mcp-session-id");

  if (method === "DELETE") {
    if (STATELESS) return new Response(null, { status: 405 });
    if (!sessionId || !sessions.has(sessionId)) return jsonError(404, -32001, "Session not found");
    const entry = sessions.get(sessionId)!;
    sessions.delete(sessionId);
    await entry.transport.close().catch(() => {});
    return new Response(null, { status: 200 });
  }

  if (method === "GET") {
    // فتح تيار SSE لاستقبال الإشعارات/طلبات الخادم — يحتاج جلسة قائمة (ولا يعمل في وضع stateless)
    if (STATELESS) return new Response(null, { status: 405 });
    if (!sessionId || !sessions.has(sessionId)) return jsonError(404, -32001, "Session not found");
    sweepStaleSessions();
    const entry = sessions.get(sessionId)!;
    entry.lastAccess = Date.now();
    return await entry.transport.handleRequest(request);
  }

  if (method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "GET, POST, DELETE" },
    });
  }

  // POST: رسائل JSON-RPC
  sweepStaleSessions();

  // طلب بجلسة قائمة → أعد استخدام نفس النقل (يصادق على mcp-session-id داخليًا)
  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return jsonError(404, -32001, "Session not found — reinitialize");
    entry.lastAccess = Date.now();
    return await entry.transport.handleRequest(request);
  }

  // لا جلسة بعد → initialize (أو أي POST جديد في وضع stateless)
  const transport = createSessionPair();
  const response = await transport.handleRequest(request);

  // طلب غير initialize بلا جلسة في الوضع الجلسي → النقل يرفضه بنفسه؛ نظّف الزوج غير المستخدم
  if (!STATELESS && !transport.sessionId) {
    await transport.close().catch(() => {});
  }
  return response;
}

export async function GET(request: Request) {
  await dbHealthy().catch(() => false); // تأكد من جاهزية المخطط عند أول وصول
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}
export async function DELETE(request: Request) {
  return handle(request);
}

/** فحص جاهزية سريع للمسار (بدون توثيق) */
export async function OPTIONS() {
  return new Response(JSON.stringify({ ...SERVER_INFO, transport: "streamable-http" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
