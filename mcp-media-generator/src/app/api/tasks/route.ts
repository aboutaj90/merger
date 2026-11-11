/**
 * GET /api/tasks — أحدث المهام + الإحصائيات للوحة المهام (تحدّث الواجهة كل ~5 ثوانٍ)
 */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats, type TaskRow } from "@/lib/turso";
import { parseUrls } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  completedAt: string | null;
}

function toDashboardTask(t: TaskRow): DashboardTask {
  let attempts = 0;
  try {
    attempts = (JSON.parse(t.attempts_json ?? "[]") as unknown[]).length;
  } catch {
    attempts = 0;
  }
  return {
    id: t.id,
    type: t.type,
    model: t.model,
    status: t.status,
    progress: Number(t.progress ?? 0),
    provider: t.provider,
    prompt: (t.prompt ?? "").slice(0, 120),
    urls: parseUrls(t.result_urls_json),
    error: t.status === "failed" ? t.error_message : null,
    attempts,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20));
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, {
      type: ["image", "video", "merge"].includes(type ?? "") ? type : undefined,
      status: ["completed", "failed", "processing", "pending"].includes(status ?? "") ? status : undefined,
    }),
    taskStats(),
  ]);

  return NextResponse.json({ stats, tasks: tasks.map(toDashboardTask) });
}
