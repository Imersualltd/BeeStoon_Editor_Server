# BeeStoon Editor Server

سرور Colyseus برای اشتراک‌گذاری چند آبجکت GLB (هر کدام با transform خودش) بین کاربران.
با کلاینت `network-manager.mjs` در پروژهٔ PlayCanvas کار می‌کند.

## اجرای محلی (برای تست)

```bash
npm install
AUTH_PROVIDER=dev ALLOW_DEV_AUTH=true npm start
```

بعد در مرورگر `http://localhost:2567` را باز کنید. باید `{"ok":true,...}` ببینید.

تست خودکار نقش‌ها و جلسه‌ها (سرور را خودش روی یک پورت آزاد اجرا می‌کند):

```bash
npm test
```

## استقرار روی سرور ابری

هر سرویسی که Node.js 22 و WebSocket را پشتیبانی کند جواب می‌دهد.
پورت را سرویس از طریق متغیر `PORT` می‌دهد و کد خودش آن را می‌خواند.

- روی Render سرویس به‌صورت **Docker** اجرا می‌شود (`render.yaml` و `Dockerfile`)،
  چون خروجی FBX به ابزار `assimp` نیاز دارد که در Docker image نصب می‌شود.
- Health check: `/health`

بعد از استقرار، آدرس HTTPS سرویس (مثلاً `https://editor-server.your-domain.com`)
را در attribute **Server Url** روی entity `NetworkManager` بگذارید.

## محدودیت‌ها

- خود جلسه (افراد، نقش‌ها، قفل‌ها، transform آبجکت‌ها) در حافظه است و با رفتن آخرین نفر یا
  ری‌استارت سرور پاک می‌شود (کلاینت‌ها بعد از وصل شدن دوباره، آبجکت‌های خودشان را دوباره می‌فرستند).
  فایل مدل‌ها در فضای ذخیره‌سازی است (بخش «فایل مدل‌ها» پایین‌تر).
- محدودیت هر جلسه به **نوع جلسه** بستگی دارد (`src/session-types.mjs`):

| نوع (`sessionType`) | تعداد نفرات (با admin) | حجم همه مدل‌ها | حجم هر فایل |
|---|---|---|---|
| `single` | ۱ | ۲۵۰ MB | ۵۰ MB |
| `basic` (پیش‌فرض) | ۸ | ۲۵۰ MB | ۵۰ MB |
| `workshop` | ۵۰ | ۵۰۰ MB | ۵۰ MB |

  یک نفر در چند مرورگر یک نفر حساب می‌شود. فایلی که دو بار استفاده شود یک بار حساب می‌شود.
  مدلی که جا نشود فقط روی صفحه فرستنده می‌ماند.
- کلاینت‌های قدیمی که مدل را به‌صورت data URL در پیام می‌فرستند هنوز کار می‌کنند؛ آن مدل‌ها
  در حافظه می‌مانند و سقف `MAX_ROOM_MB` (پیش‌فرض ۲۵۰) و حدود ۱۰ مگابایت برای هر فایل را دارند.

## جلسه‌ها، نقش‌ها و ورود

- هر لینک اشتراک یک **جلسه** (اتاق جدا) است. سازنده با
  `create('session', { sessionKey })` یک کلید تصادفی جدید می‌سازد؛ بقیه با
  `join('session', { sessionKey })` و همان کلید وارد می‌شوند.
- سازنده اولین **admin** است. بقیه در حالت **pending** منتظر می‌مانند تا یک
  admin آن‌ها را به‌عنوان admin / editor / viewer تأیید کند. کاربر pending هیچ
  داده مدلی دریافت نمی‌کند.
- **admin** همه چیز را ویرایش می‌کند. **editor** آبجکت آزاد یا آبجکتی که به خودش
  assign شده را ویرایش می‌کند؛ در حین ویرایش آبجکت برای او قفل (hold) است.
  **viewer** فقط می‌بیند (AR مجاز است).
- جلسه هیچ‌وقت بدون admin نمی‌ماند: اگر آخرین admin بدون انتخاب برود (یا تب را ببندد و در
  `RECONNECT_WINDOW` برنگردد، یا غیرفعال شود)، قدیمی‌ترین editor آنلاین admin می‌شود. اگر editor
  نباشد، جلسه بسته می‌شود (و ذخیره می‌شود). مالک (سازنده جلسه) همیشه مالک می‌ماند (`owner` در state).
- هر کس `IDLE_MINUTES` دقیقه (پیش‌فرض ۶۰) هیچ فعالیتی نداشته باشد (کلاینت پیام `activity` می‌فرستد)
  با کد `4105` از جلسه خارج می‌شود؛ `IDLE_WARNING_MINUTES` (پیش‌فرض ۵) قبلش `session:idle-warning` می‌گیرد.
  نقشش حفظ می‌شود و با لینک برمی‌گردد.
- admin می‌تواند آبجکتی را که editor در دست دارد بگیرد و جابه‌جا کند (`overrideBy`)؛ قفل پیش editor
  می‌ماند و editor تا رها کردن admin صبر می‌کند (برای VR و دسکتاپ).
- جزئیات همه پیام‌ها در سرآیند `src/ModelRoom.mjs` آمده است.

### هویت (قابل تعویض)

| متغیر | توضیح |
|---|---|
| `AUTH_PROVIDER=dev` | به `identity: { userId, name }` که کلاینت می‌فرستد اعتماد می‌کند. فقط برای توسعه؛ نیاز به `ALLOW_DEV_AUTH=true` دارد. |
| `AUTH_PROVIDER=jwt` | توکن امضاشده سایت (مثلاً BeeStoon) را بررسی می‌کند: `JWT_SECRET` (HS256) یا `JWT_PUBLIC_KEY` (RS256)، و اختیاری `JWT_ISSUER`. `sub` = شناسه، `name` = نام، `email` = برای دعوت ایمیلی. |

### یک نفر در چند مرورگر

همان `userId` (همان لاگین BeeStoon) در چند مرورگر یا دستگاه **یک نفر** است: نقش و دسترسی‌اش
حفظ می‌شود و دوباره منتظر تأیید نمی‌ماند. هر دو اتصال باز می‌مانند (دیگر کد `4104` فرستاده نمی‌شود).
در `session:state` هر نفر `devices` دارد (تعداد مرورگرهای باز) و admin مقدار `connections`
(کل اتصال‌ها، که هزینه سرور بر اساس آن است) را می‌بیند. Leave در یک مرورگر فقط همان مرورگر را
می‌بندد، مگر اینکه جلسه را ببندد.

### دعوت با ایمیل

| متغیر | توضیح |
|---|---|
| `MAIL_PROVIDER=resend` | ایمیل از طریق [Resend](https://resend.com): `RESEND_API_KEY` و `INVITE_FROM` (مثلاً `Beestoon <invite@beestoon.com>`، دامنه باید در Resend تأیید شده باشد). |
| `MAIL_PROVIDER=log` | ایمیل فقط در لاگ سرور چاپ می‌شود (توسعه و تست). |
| (تنظیم نشده) | دعوت ایمیلی سمت سرور خاموش است؛ کلاینت برنامه ایمیل خود admin را باز می‌کند. |
| `INVITE_BASE_URL` | اختیاری: اگر لینکی که کلاینت می‌فرستد معتبر نباشد، لینک دعوت از این آدرس + `?session=` ساخته می‌شود. |

وقتی ایمیل فعال است، `session:state.features.emailInvites = true` (فقط برای admin).
admin پیام `invite:email` را با `{ emails, role, link }` می‌فرستد (حداکثر ۲۰ آدرس در هر پیام،
۵۰ دعوت در ساعت برای هر جلسه) و جواب `invite:result { sent, failed }` می‌گیرد. کسی که با همان
ایمیل وارد شود، بدون انتظار با همان نقش وارد جلسه می‌شود.

### مسیرهای HTTP

`/convert` و `/export/fbx` فقط برای admin و editor یک جلسه زنده کار می‌کنند.
کلاینت «تیکت» شخصی‌اش را (که در `session:state` → `you.ticket` می‌آید) در هدر
`Authorization: Bearer <ticket>` می‌فرستد. نقش در لحظه بررسی می‌شود.

### فایل مدل‌ها (`/assets`)

مدل‌ها دیگر به‌صورت متن از داخل جلسه رد نمی‌شوند. editor یا admin فایل GLB را یک بار آپلود می‌کند
و فقط شناسه آن را در جلسه می‌فرستد (جزئیات در سرآیند `src/assets.mjs`):

1. `POST /assets?name=<نام فایل>` با بدنه GLB و هدر `Authorization: Bearer <ticket>` →
   `{ assetId, size, url }`. اگر فایل یا کل جلسه از سقف نوع جلسه بیشتر شود: `413`.
2. پیام `object:add` با `{ id, name, assetId, transform }`. بقیه `{ ..., assetId, size, url }` می‌گیرند.
3. `GET /assets/<sceneId>/<assetId>.glb` فایل را می‌دهد. با `s3` این آدرس به یک لینک امضاشده
   کوتاه‌مدت در باکت redirect می‌شود، پس دانلود از Spaces است و از سرور Render رد نمی‌شود
   (هزینه ارسال داده در Spaces حدود ۱۵ برابر کمتر است).

فایل‌ها بر اساس محتوا (sha256) یک بار ذخیره می‌شوند، در `<sceneId>/blobs/<assetId>.glb`.

| متغیر | توضیح |
|---|---|
| `SCENE_STORAGE` | `local` یا `s3`. پیش‌فرض همان `AR_STORAGE`. |
| `SCENE_LOCAL_DIR` | پوشه برای `local` (پیش‌فرض پوشهٔ temp؛ روی Render با هر deploy پاک می‌شود). |
| `SCENE_S3_PREFIX` | پیشوند در باکت برای `s3` (پیش‌فرض `scenes/`). بقیه تنظیمات همان `S3_*` لینک AR است. |

**CORS روی باکت Spaces لازم است** تا صفحه PlayCanvas بتواند فایل را از لینک امضاشده بخواند:
در تنظیمات Space → CORS یک قانون با Origin `https://launch.playcanvas.com` (و دامنه نسخه منتشرشده،
و `https://playcanvas.com` برای Editor)، متد `GET` و `HEAD`، و Allowed Headers `*` اضافه کنید.

### ذخیره جلسه و نسخه‌ها

- اولین ذخیره (دستی یا خودکار)، جلسه را به یک **جلسه ذخیره‌شده** تبدیل می‌کند که مالکش سازنده
  جلسه است و تا وقتی خودش پاکش نکند می‌ماند (جزئیات در `src/scene-versions.mjs`).
- `scene:save { name, description }`: admin و editor یک نسخه با نام و توضیح ذخیره می‌کنند.
  `scene:versions`: همه فهرست نسخه‌ها را می‌بینند. `scene:restore { versionId }`: فقط admin.
  قبل از بازگردانی، تغییرات ذخیره‌نشده به‌صورت نسخه «Before restore» نگه داشته می‌شود.
- ذخیره خودکار هر `AUTOSAVE_MINUTES` دقیقه (پیش‌فرض ۵) اگر چیزی تغییر کرده باشد، و موقع
  تمام شدن جلسه. ۲۰ ذخیره خودکار آخر و حداکثر ۵۰ نسخه دستی نگه داشته می‌شود.
- همان لینک جلسه بعداً دوباره کار می‌کند، ولی **فقط مالک** می‌تواند آن را باز کند. بعد کسانی
  که قبلاً در جلسه بودند با همان نقش وارد می‌شوند؛ افراد جدید منتظر تأیید می‌مانند.
- حداکثر جلسه ذخیره‌شده برای هر نفر: single ۱۰، basic ۱۰، workshop ۵
  (`SAVED_SESSIONS_LIMIT` برای تست همه را عوض می‌کند).
- ذخیره‌سازی همان `SCENE_STORAGE` است؛ برای ماندگاری روی Render باید `s3` (Spaces) باشد.

### جلسه‌های من (`/sessions`)

فهرست صفحه شروع: جلسه‌هایی که هر کس الان داخلشان است (با هر نقشی) و جلسه‌های ذخیره‌شده‌ای که
مالکشان است یا در آن‌ها بوده (جزئیات در `src/my-sessions.mjs`). باز کردن هر کدام همان لینک
`?session=<sessionKey>` در همان تب است.

- هویت مثل ورود به جلسه: با `AUTH_PROVIDER=jwt` هدر `Authorization: Bearer <توکن BeeStoon>`،
  با `dev` هدر `X-Identity: {"userId":"...","name":"..."}` (حساب تست ثابت هر مرورگر).
- `GET /sessions/mine` → `{ live: [...], saved: [...] }`. در `saved` نام، تاریخ ساخت، آخرین فعالیت،
  فهرست افراد (با علامت مالک) و آخرین نسخه (نام، توضیح، زمان، ذخیره‌کننده) هست.
- `DELETE /sessions/<sessionKey>`: فقط مالک، و فقط وقتی جلسه باز نیست (`409`). همه نسخه‌ها و فایل‌های
  مدل پاک می‌شوند و لینک بسته می‌ماند.

### اعتبار (Credits)

- هر نفر یک موجودی اعتبار دارد. تا وقتی ورود BeeStoon آماده شود، موجودی‌ها در همان فضای ذخیرهٔ جلسه‌ها
  (`wallets/`) نگه داشته می‌شوند و هر نفر جدید با `CREDITS_START` اعتبار شروع می‌کند (پیش‌فرض ۲۰).
  `CREDITS_ENABLED=false` همه را خاموش می‌کند.
- سازندهٔ جلسه هزینهٔ نوع جلسه (Single ۱، Basic ۲، Workshop ۳) به‌اضافهٔ «استخر اعتبار» را می‌پردازد
  (گزینه‌های ساخت: `creditPool`، `poolForEntry`، `poolForModels`). اگر کافی نباشد: خطای 402.
- هر شرکت‌کنندهٔ جدید برای ورود ۱ اعتبار می‌پردازد (هر جلسه فقط یک‌بار؛ مرورگر دوم و برگشتن رایگان است).
  اگر ادمین گفته باشد استخر هزینهٔ ورود را بدهد و استخر هنوز اعتبار داشته باشد، استخر می‌پردازد؛
  وگرنه خود شخص. کسی که نه خودش اعتبار دارد و نه استخر می‌پردازد، با 402 رد می‌شود.
- ادمین: `credits:add { amount }` (از اعتبار خودش به استخر اضافه می‌کند) و
  `credits:pool { forEntry, forModels }`. وضعیت در `session:state.credits`
  (`pool.total/left/forEntry/forModels`، `balance` خود شخص).
- `GET /credits/mine` (همان هدرهای «جلسه‌های من») → `{ enabled, balance, sessionCosts, entryCost }`.
- باز کردن دوبارهٔ جلسهٔ ذخیره‌شده رایگان است و استخرش با جلسه ذخیره می‌ماند.
- `room.spendForModel(userId, amount)` برای ساخت مدل BeeStoon آماده است (اول استخر اگر اجازه داشته باشد).

## پروتکل پیام‌ها

| جهت | پیام | داده |
|---|---|---|
| کلاینت → سرور | `object:add` | `{ id, name, dataUrl, transform? }` |
| کلاینت → سرور | `object:transform` | `{ id, position, rotation, scale }` |
| کلاینت → سرور | `object:remove` | `{ id }` |
| کلاینت → سرور | `object:hold` / `object:release` | `{ id }` |
| کلاینت → سرور | `sync-request` | `{ have: [id, ...] }` |
| کلاینت → سرور | `session:leave` | `{ choice: close\|keep\|assign, newAdminId? }` |
| admin → سرور | `join:approve` / `join:deny` | `{ userId, role? }` |
| admin → سرور | `role:set` | `{ userId, role }` |
| admin → سرور | `object:assign` / `object:unassign` / `object:swap` | `{ id, userId }` / `{ id }` / `{ idA, idB }` |
| admin → سرور | `user:kick` / `session:close` | `{ userId }` / `{}` |
| admin → سرور | `invite:email` | `{ emails, role, link }` |
| سرور → admin | `invite:result` | `{ sent, failed }` |
| سرور → کلاینت | `session:state` | وضعیت جلسه، شخصی برای هر نفر |
| سرور → admin | `join:request` | `{ userId, name }` |
| سرور → کلاینت | `object:list` | `{ serverId, ids }` |
| سرور → کلاینت | `object:add` / `object:transform` / `object:remove` | مثل بالا |
| سرور → فرستنده | `object:rejected` | `{ id, reason }` (حافظه پر است) |
| سرور → فرستنده | `object:denied` | `{ id, reason, transform? }` (اجازه ندارد) |
| سرور → فرستنده | `action:denied` | `{ type, reason }` |
| سرور → کلاینت | `session:notice` / `session:closed` | `{ text }` / `{ by }` |

کدهای قطع اتصال: `4101` اخراج، `4102` رد درخواست، `4103` بسته شدن جلسه
(`4104` دیگر فرستاده نمی‌شود؛ چند مرورگر مجاز است).

## خروجی FBX

`POST /export/fbx?name=<نام فایل>` با بدنهٔ GLB.
پاسخ: اگر مدل تکسچر داشته باشد یک فایل ZIP (فایل FBX + تصاویر تکسچر کنار آن)،
وگرنه خود فایل FBX. تبدیل با `assimp` انجام می‌شود (بستهٔ `assimp-utils` در Dockerfile).
تکسچرها جدا گذاشته می‌شوند چون FBX با تکسچر توکار از assimp در Blender درست باز نمی‌شود.


## لینک AR (نمایش در اندازهٔ واقعی روی هر گوشی)

دکمهٔ AR در ادیتور می‌پرسد «Selected» یا «All scene»، از آن یک GLB می‌سازد و به
`POST /ar/snapshots?name=<نام>` می‌فرستد (`Authorization: Bearer <ticket>`؛ هر عضو تأییدشدهٔ جلسه،
viewer هم). پاسخ: `{ id, url, expiresAt }`.

- `GET /ar/<id>` صفحهٔ نمایش (بدون ورود): با `<model-viewer>` گوگل؛ اندروید Scene Viewer / WebXR،
  آیفون AR Quick Look (فایل USDZ روی خود گوشی از GLB ساخته می‌شود). `ar-scale="fixed"` یعنی اندازهٔ واقعی
  (۱ واحد PlayCanvas = ۱ متر).
- `GET /ar/<id>/model.glb` خود مدل.
- هر بار زدن دکمه یک لینک تازه می‌سازد. لینک بعد از `AR_LINK_HOURS` ساعت (پیش‌فرض ۲۴) منقضی و پاک می‌شود.

| متغیر | توضیح |
|---|---|
| `AR_STORAGE=local` | پیش‌فرض. فایل‌ها در پوشهٔ `AR_LOCAL_DIR` (پیش‌فرض پوشهٔ temp). روی Render با هر deploy پاک می‌شود. |
| `AR_STORAGE=s3` | هر فضای سازگار با S3، مثلاً DigitalOcean Spaces: `S3_ENDPOINT` (مثلاً `https://fra1.digitaloceanspaces.com`)، `S3_REGION` (مثلاً `fra1`)، `S3_BUCKET`، `S3_ACCESS_KEY_ID`، `S3_SECRET_ACCESS_KEY`، اختیاری `S3_PREFIX` (پیش‌فرض `ar-snapshots/`). باکت خصوصی می‌ماند؛ سرور فایل را به گوشی می‌فرستد. |
| `AR_LINK_HOURS` | عمر لینک به ساعت (پیش‌فرض ۲۴). |
| `PUBLIC_BASE_URL` | اختیاری: آدرس عمومی سرور برای ساختن لینک (مثلاً `https://ar.beestoon.com`)؛ وگرنه از آدرس درخواست ساخته می‌شود. |

پیشنهاد برای Spaces: یک Lifecycle rule روی پیشوند `ar-snapshots/` (حذف بعد از ۲ روز) به‌عنوان پشتیبان پاک‌سازی خود سرور.
