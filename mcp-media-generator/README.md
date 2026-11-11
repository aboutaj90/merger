# MCP Media Generator

خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية.

- **توليد صور** من وصف نصي — الموديل المدمج: `gpt-image-2-6/flare-text-to-image`
- **توليد فيديو** مع صوت متزامن أصلي — الموديل المدمج: `grok-imagine-video-1-5-preview`
- **دمج عدة مقاطع** في مقطع واحد عالي الجودة عبر خدمة الدمج (مجلد `merger-site` في نفس المستودع)

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ gpt-image-2-6/flare-text-to-image — تعيد الرابط جاهزًا إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بـ grok-imagine-video-1-5-preview (صوت متزامن، image-to-video اختياري) — `task_id` ويُتابع بـ `get_task` |
| `merge_videos` | دمج مقاطع بالترتيب عبر `urls` (روابط مباشرة) أو `task_ids` (مهام فيديو مكتملة) — 2 إلى 10 مقاطع |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يحدّث حية من المزود/خدمة الدمج |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

## قواعد جوهرية مطبَّقة

1. **لا يُنزَّل أي ملف وسائط على السيرفر** — روابط النتائج فقط في قاعدة البيانات.
2. **الترتيب التسلسلي الصارم للمفاتيح** (`created_at ASC, id ASC`) — أول مفتاح أُضيف يُجرَّب أولًا؛ ليس round-robin.
3. **تبديل تلقائي فوري** عند أي خطأ مفتاح/رصيد/حد استخدام — نفس المهمة تُستأنف بنفس `task_id` دون توقف.
4. **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — يرى «قيد المعالجة» فقط.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد تلقائيًا مع كل `get_task` بعد تهدئة ~45 ثانية — لو شحنت رصيدًا تكتمل من تلقاء نفسها.
6. المفاتيح مستنزفة الرصيد تبقى في القاعدة (`exhausted`) دون عرقلة المفاتيح التالية؛ التعطيل اليدوي (`disabled`) هو الاستثناء الوحيد.
7. **إخفاء المفاتيح إلزامي** (`maskKey`: أول 7 + نقاط + آخر 4) في كل الاستجابات.
8. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء الشبكة = مؤقتة وتستمر بالاستعلام.
9. ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — التنبيه مذكور في وصف الأداة وSERVER_INSTRUCTIONS.
10. أثناء نافذة الانتظار يُبَث **تقدم حي** (Progress notifications كل ~3 ثوانٍ) إذا زوّد العميل الطلب بـ `_meta.progressToken`.

## التشغيل محليًا

```bash
bun install   # أو npm install
cp .env.example .env.local   # ثم عبّئ القيم
bun run dev   # http://localhost:3000
```

### متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso مثل `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | نعم | رابط خدمة الدمج المنشورة (مجلد merger-site) |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `MCP_STATELESS` | لا | `1` لتشغيل وضع بلا جلسات (بيئات serverless متعددة النسخ) |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى CometAPI |

## النشر على Vercel

1. اربط المستودع بمشروع Vercel جديد واجعل **Root Directory = `mcp-media-generator`**.
2. أضف المتغيرات الثلاثة الإلزامية في Settings → Environment Variables.
3. Deploy — كل شيء يعمل بدون ملفات محلية: libSQL يتصل عبر HTTP، ومسار `/mcp` يدعم الـ streaming.
4. `vercel.json` يضبط `maxDuration: 300` لدوال المسارات (حسب خطتك على Vercel قد يُقصّ هذا الحد).
5. ملاحظة الجلسات: الجلسات تُحفظ في الذاكرة لكل نسخة Lambda دافئة؛ إن ظهرت مشاكل جلسات على Vercel اضبط `MCP_STATELESS=1`.

## ربط العملاء

من لوحة الإدارة (تبويبات جاهزة للنسخ):

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server → ضَع الرابط في «Server URL».
- **Claude Desktop**: ملف `claude_desktop_config.json`:
  ```json
  { "mcpServers": { "media-generator": { "type": "http", "url": "https://<your-app>.vercel.app/mcp" } } }
  ```
- **Cursor / Windsurf / Cline**: ملف `mcp.json` بنفس الصيغة.

## اختبار سريع بـ curl

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# → خذ mcp-session-id من الترويسات ثم:

curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```

## الواجهة

صفحة واحدة (لوحة إدارة عربية RTL):
- **هيدر**: شارة «Turso متصل» الخضراء/الحمراء + حالة خدمة الدمج.
- **أ) مدير المفاتيح**: إضافة (مزود + تسمية + مفتاح) مع رفض التكرار، قائمة مقنّعة مع عدّادات الاستخدام/النجاح/الفشل وآخر خطأ، تعطيل/تنشيط/حذف.
- **ب) لوحة المهام**: إحصائيات (إجمالي/مكتملة/فاشلة/جارية) + أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ مع شريط تقدم وأزرار فتح الروابط وعدد المحاولات.
- **ج) ربط السيرفر**: رابط MCP + JSON جاهز لثلاثة عملاء + رقائق الأدوات الخمس + ملاحظة كهرمانية عن توقيت الفيديو.

## البنية

```
src/
  lib/
    turso.ts          طبقة Turso: المخطط + عمليات المهام والمفاتيح (إلحاق attempts ذرّي عبر json_insert)
    keys.ts           الترتيب التسلسلي + classifyProviderError + maskKey
    models.ts         سجل MODELS مع الصيغ البديلة (شرطات/نقاط) والتجاوز بالبيئة
    providers/        kie.ts (Jobs API) + cometapi.ts (صور متزامنة OpenAI-متوافقة + فيديو غير متزامن)
    generation.ts     runGeneration / refreshTask / runMerge / refreshMergeTask — قلب التبديل التسلسلي
    merger.ts         عميل Video Merger API v2 الدفاعي
    mcp.ts            الأدوات الخمس + SERVER_INSTRUCTIONS
    format.ts         صياغة الردود العربية
  app/
    mcp/route.ts      خادم MCP (نقل Streamable HTTP الرسمي عبر SDK)
    api/health        فحص شامل
    api/keys(+[id])   إدارة المفاتيح للواجهة
    api/tasks         المهام للوحة
    page.tsx          اللوحة
```

## ملاحظات اختبار مُثبتة فعليًا

- توليد صورة حقيقي عبر kie.ai → رابط PNG يعمل (HTTP 200 image/png).
- تبديل تسلسلي: مفتاح خاطئ أولًا ثم صحيح → المهمة اكتملت على الثاني، الخاطئ صار `disabled`، ولم يصل العميل أي ذكر للمفاتيح.
- مفتاح نفد رصيده أثناء الفيديو → ظهر `exhausted` وبقي في القاعدة، والمهمة بقيت `processing` تُعاد مع كل `get_task` (تكتمل تلقائيًا بعد شحن الرصيد).
- دمج مقطع مولّد حقيقي + مقطع عام عبر `merge_videos` → MP4 نهائي على نطاق خدمة الدمج يعمل ويُشغَّل، مع تحذير الـ 24 ساعة.
- رفض أقل من مقطعين وأكثر من 10 برسائل عربية، وحل `task_ids` بالترتيب.
