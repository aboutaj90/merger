# MCP Media Generator + Video Merger

مشروعان مترابطان في مستودع واحد:

| المجلد | المشروع | الوصف |
|---|---|---|
| `mcp-media-generator/` | **خادم MCP لتوليد الوسائط** | خادم MCP (Next.js + TypeScript) يعرض 5 أدوات: توليد صور، توليد فيديو بصوت متزامن، دمج مقاطع، تتبع المهام، واسترجاع الوسائط — مع لوحة إدارة عربية RTL ونظام تبديل مفاتيح تسلسلي صامت. |
| `merger-site/` | **موقع دمج الفيديوهات** | موقع Node.js خالص (بلا خطوة بناء) يُنشر على Vercel Serverless مع Turso — واجهة عربية داكنة لدمج الفيديوهات + واجهة API عامة للمطورين. |

## كيف يعملان معًا؟

```
عميل MCP (ChatGPT / Claude / Cursor / ...)
        │  JSON-RPC على /mcp
        ▼
mcp-media-generator  ──── توليد صور/فيديو عبر kie.ai و CometAPI
        │                       (تبديل مفاتيح تسلسلي صامت)
        │  MERGER_API_BASE
        ▼
merger-site  ──── دمج المقاطع في MP4 واحد (ffmpeg + Turso Blobs)
```

خادم MCP يستدعي خدمة الدمج عبر `MERGER_API_BASE`، فانشر خدمة الدمج أولًا ثم مرّر رابطها لخادم MCP.

## النشر السريع على Vercel

1. **خدمة الدمج أولًا:**
   - ارفع المستودع إلى GitHub ثم في Vercel: **Add New Project** → اختر المستودع → **Root Directory = `merger-site`**.
   - أضف متغيري البيئة: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (انظر دليل `merger-site/README.md`).
   - بعد النشر خذ رابط النطاق مثل `https://your-merger.vercel.app`.
2. **خادم MCP:**
   - مشروع جديد ثانٍ بنفس المستودع مع **Root Directory = `mcp-media-generator`**.
   - أضف المتغيرات: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، و `MERGER_API_BASE=https://your-merger.vercel.app` (انظر `mcp-media-generator/README.md`).
3. افتح لوحة خادم MCP وانسخ إعدادات الربط الجاهزة لأي عميل MCP.

## الأمان

- لا توجد أسرار في المستودع — كل ملفات `.env*` مستثناة من Git منذ أول commit.
- مفاتيح API تُخفى دائمًا (`maskKey`) في كل استجابات واجهة MCP.
- لا يُنزَّل أي ملف وسائط على خادم MCP إطلاقًا — الروابط فقط.
