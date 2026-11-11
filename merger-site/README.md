# موقع دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على Vercel.

- **Node.js خالص (CommonJS)** بدون Next.js أو React أو أي خطوة بناء: واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`.
- **Turso (libSQL)** تخزّن كل شيء: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — لا S3 ولا خدمات خارجية.
- **ffmpeg-static + ffprobe-static**: معالجة الفيديو داخل الدالة نفسها (مع نسخ الثنائي إلى `/tmp` بصلاحية 755 عند فقدان التنفيذ).

## المخرجات والقيود

- الناتج: **MP4 (H.264 CRF 18 + AAC 192k)** حتى 1080p — `+faststart` ليعمل فورًا على الويب.
- توحيد كل المصادر: scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p ثم concat.
- مصدر بلا صوت؟ يُضاف مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج.
- **10 مقاطع كحد أقصى** · 200MB لكل مصدر · 150MB للناتج · 600 ثانية مجموع المدد.
- **كل الملفات تُحذف تلقائيًا بعد 24 ساعة** (تنظيف كسول + `/api/cron` مجدول يوميًا).

## واجهة API العامة (بدون تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range (استجابة 206)، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/jobs` | قائمة أحدث المهام |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي) |

### أمثلة curl (بعد النشر استبدل الدومين)

```bash
# 1) إنشاء مهمة من روابط
curl -X POST https://your-merger.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
# 201 → {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 2) تنفيذ الدمج (متزامن ~10-60 ثانية)
curl -X POST https://your-merger.vercel.app/api/jobs/<jobId>/process
# 200 → {"status":"done","videoUrl":"https://.../api/jobs/<id>/video","downloadUrl":"...?download=1",
#        "size":1234567,"duration":30.2,"resolution":"1280x720","expiresAt":"..."}

# 3) الحالة والتقدم
curl https://your-merger.vercel.app/api/jobs/<jobId>

# 4) بث الناتج بدعم Range / تحميل
curl -H "Range: bytes=0-1023" https://your-merger.vercel.app/api/jobs/<id>/video -o part.mp4   # 206
curl "https://your-merger.vercel.app/api/jobs/<id>/video?download=1" -o merged.mp4

# 5) مهمة بملفات من الجهاز: أنشئ بالمصادر ثم ارفع الأجزاء ثم نفّذ
curl -X POST https://your-merger.vercel.app/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"local.mp4","size":9437184,"mime":"video/mp4"}]}'
# 201 → uploads[] مع uploadUrl لكل مصدر + uploadChunkBytes (4MB)
curl -X POST "https://your-merger.vercel.app/api/upload?job=<jobId>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part0.bin
# كرر لكل جزء ثم: POST /api/jobs/<jobId>/process

# 6) الحذف والحدود
curl -X DELETE https://your-merger.vercel.app/api/jobs/<jobId>
curl https://your-merger.vercel.app/api/config
```

### أكواد الحالة

- `400` مدخلات تالفة · `404` غير موجود · `405` طريقة خاطئة · `409` حالة غير مناسبة (مثل الرفع بعد اكتمال المعالجة) · `413` تجاوز الحجم · `416` مدى Range غير صالح · `500` فشل دمج برسالة واضحة.

## خطوات النشر على Vercel

### 1) إنشاء قاعدة Turso والحصول على التوكن

```bash
# ثبّت CLI ثم سجّل الدخول
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup        # أو turso auth login

# أنشئ قاعدة مجانية
turso db create merger-db

# اجلب الرابط والتوكن
turso db show merger-db --url          # ← TURSO_DATABASE_URL
turso db tokens create merger-db       # ← TURSO_AUTH_TOKEN
```

### 2) اربط المستودع بـ Vercel

1. ارفع هذا المجلد (أو المستودع كاملًا مع Root Directory = `merger-site`) إلى GitHub ثم في Vercel: **Add New… → Project**.
2. في **Settings → Environment Variables** أضف:
   - `TURSO_DATABASE_URL` = قيمة `turso db show --url`
   - `TURSO_AUTH_TOKEN` = قيمة `turso db tokens create`
3. اضغط **Deploy**. (متغيرات الحدود الاختيارية انظر الجدول أدناه — لا حاجة لتعديلها عادة.)
4. بعد النشر اختبر بـ curl كما في الأمثلة أعلاه (استبدل الدومين بنطاقك).

### 3) جدولة التنظيف اليومي

`vercel.json` يعرّف بالفعل:

```json
{ "crons": [{ "path": "/api/cron", "schedule": "0 3 * * *" }] }
```

التنظيف كسول أيضًا: يُنفَّذ عند كل طلب إنشاء/دمج فلا تتراكم المهام المنتهية.

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | نعم | — | توكن كتابة |
| `MAX_SOURCES` | لا | 10 | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | لا | 200 | أقصى حجم لكل مصدر |
| `OUTPUT_MAX_MB` | لا | 150 | أقصى حجم للناتج |
| `MAX_TOTAL_DURATION_SEC` | لا | 600 | أقصى مجموع المدد |
| `FFMPEG_PRESET` | لا | medium | preset الترميز (فaster/medium/slow) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | لا | — | تجاوز مسار الثنائيات إن لزم |

## التشغيل محليًا

```bash
cp .env.example .env     # ثم عبّئ متغيري Turso
npm install
npm run dev              # http://localhost:3030
```

`server.js` خادم تطوير يحاكي بيئة Vercel: يحمّل `.env` يدويًا، يحلّل المسارات الديناميكية ويضعها في `req.query`، ويخدم `public/index.html`.

## الاختبارات

```bash
# اختبار وحدات: توليد فيديوهين بـ ffmpeg مختلفي الدقة → دمج → تحقق الدقة/المدة/الصوت
# + تخزين Turso واسترجاع بتطابق sha256 + رفع الأجزاء + حدود الحجم + الحذف الشامل
npm run test:unit        # 13 اختبارًا

# اختبار HTTP كامل ضد خادم التطوير: روابط → دمج → بث Range 206 → مهمة مختلطة
# (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → حدود العدد → قائمة نظيفة
npm run test:http        # 24 اختبارًا
```

## الواجهة

عربية RTL بثيم داكن حديث بتدرجات سماوي/بنفسجي:
- حقل رابط + زر إضافة، ومنطقة **سحب وإفلات** للملفات (mp4/mov/webm/mkv/avi/m4v/mpg/3gp).
- قائمة مصادر قابلة لإعادة الترتيب **بالسحب أو أزرار ↑↓** مع حذف وترقيم واضح — ترتيب القائمة = ترتيب الدمج.
- زر «دمج الفيديوهات» ينفذ التدفق كاملًا: إنشاء → رفع أجزاء (4MB مع **إعادة محاولة ×3**) → تنفيذ → شريط تقدم حقيقي من الخادم → النتيجة.
- صفحة النتيجة: مشغل، الحجم/المدة/الدقة، تحميل، نسخ الرابط، عملية جديدة، و**عدّاد تنازلي** حتى انتهاء الصلاحية (24 ساعة).
- قسم «توثيق API» قابل للطي بأمثلة curl جاهزة بالدومين الحقيقي.
- استئناف العرض بعد تحديث الصفحة عبر `#job=<id>`.

## نقاط حرجة مثبتة

- **حد حجم الطلب في Vercel ≈4.5MB**: الرفع أجزاء POST ثنائية 4MB مع إعادة محاولة ×3 من الواجهة.
- **بث الفيديو يدعم Range**: صفوف Blobs تُقرأ تدفقيًا (8 صفوف/صفحة) مع تقليم أول/آخر جزء حسب المدى → استجابة 206 + Content-Range للتقديم/الترجيع.
- **لا نظام ملفات دائم**: `/tmp` فقط أثناء المعالجة مع تنظيف في `finally`.
- **كل Blob يُقسَّم لصفوف 2MB** (حد HTTP في Turso) — الناتج يُخزَّن ويُبَث ويُحذف بذاته.
- بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.
- التحقق من الحدود قبل وأثناء العمل (عدد المصادر، الحجم أثناء التنزيل بمعدّل بايتات، حجم الناتج، مجموع المدد) — تجاوز أي حد = فشل واضح برسالة عربية وليس انهيارًا.
- `.env` في `.gitignore` + `.env.example` بدون قيم حقيقية.

## حدود الخطة المجانية التي يجب معرفتها

- **Vercel Hobby**: مدة الدالة حتى 60 ثانية افتراضيًا (الرفع من `maxDuration` في `vercel.json` يحتاج خطة Pro؛ بدونها قلّل عدد/مدد المقاطع لكل عملية). حجم الطلب ≈4.5MB لذا الرفع بالأجزاء إلزامي. التنفيذ محلي عبر ffmpeg داخل الدالة يستهلك من وقت الدالة.
- **Turso Free**: حتى 500 قاعدة، تخزين ≈5GB، 500M قراءة صف/شهر و10M كتابة/شهر — فيديو 100MB ≈ 50 صفًا من 2MB، والبث يقرأ صفحة صفحة فاحسب الاستخدام.
- المدد الطويلة (600 ثانية دمج) قد تتجاوز مهلة الدالة على الخطة المجانية — قسّم العمليات أو ارفع الخطة.

## بنية المشروع

```
api/        الدوال: jobs، jobs/[id]، process، video، upload، config، cron
lib/        db.js (Turso + المخطط) · engine.js (ffmpeg/ffprobe + الدمج) · store.js (تقسيم Blobs) · util.js
public/     index.html (الواجهة كاملة)
scripts/    test-unit.js · test-http.js
server.js   خادم تطوير يحاكي Vercel
```
