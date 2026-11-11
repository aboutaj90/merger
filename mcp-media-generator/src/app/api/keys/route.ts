/**
 * GET  /api/keys — قائمة المفاتيح كاملة مع الإخفاء الدائم (maskKey)
 * POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { listKeys, insertApiKey, findKeyByValue } from "@/lib/turso";
import { publicKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = new Set(["kie", "cometapi"]);

export async function GET() {
  const keys = await listKeys();
  return NextResponse.json({ keys: keys.map(publicKey) });
}

export async function POST(request: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "طلب تالف: جسم JSON غير صالح" }, { status: 400 });
  }

  const provider = String(body.provider ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 80);

  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ error: "مفتاح API مطلوب" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود
  const dup = await findKeyByValue(provider, apiKey);
  if (dup) {
    return NextResponse.json({ error: "هذا المفتاح مُضاف مسبقًا لنفس المزود (مكرر)" }, { status: 409 });
  }

  const id = randomUUID();
  await insertApiKey({ id, provider, label, api_key: apiKey });
  const keys = await listKeys();
  return NextResponse.json({ ok: true, keys: keys.map(publicKey) }, { status: 201 });
}
