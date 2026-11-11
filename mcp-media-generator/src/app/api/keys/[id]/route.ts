/**
 * PATCH  /api/keys/{id} — تعطيل/تنشيط يدوي
 * DELETE /api/keys/{id} — حذف نهائي
 */
import { NextResponse } from "next/server";
import { getKey, updateApiKey, deleteApiKey, listKeys } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "طلب تالف: جسم JSON غير صالح" }, { status: 400 });
  }
  const status = String(body.status ?? "");
  if (!["active", "exhausted", "disabled"].includes(status)) {
    return NextResponse.json({ error: "الحالة يجب أن تكون active أو exhausted أو disabled" }, { status: 400 });
  }
  const existing = await getKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });

  await updateApiKey(id, { status });
  const keys = await listKeys();
  return NextResponse.json({ ok: true, keys: keys.map(publicKey) });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const existing = await getKey(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteApiKey(id);
  const keys = await listKeys();
  return NextResponse.json({ ok: true, keys: keys.map(publicKey) });
}
