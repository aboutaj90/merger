/**
 * GET /api/health — فحص شامل: قاعدة البيانات، الموديلات، خدمة الدمج، حالة التوثيق
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { MERGER_BASE, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await dbHealthy();
  // فحص خدمة الدمج بمهلة 4 ثوانٍ
  const mergerOk = await mergerHealthy();

  return NextResponse.json({
    ok: dbOk,
    database: dbOk ? "turso-connected" : "disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: { base: MERGER_BASE, healthy: mergerOk },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
