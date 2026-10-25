# BE WATER – Multiplayer Server

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

بعد از استقرار، آدرس HTTPS سرویس (مثلاً `https://be-water.onrender.com`)
را در attribute **Server Url** روی entity `NetworkManager` بگذارید.

## محدودیت‌ها

- آبجکت‌ها و transform آن‌ها فقط در حافظه نگه داشته می‌شوند؛ با ری‌استارت سرور پاک می‌شوند
  (کلاینت‌ها بعد از وصل شدن دوباره، آبجکت‌های خودشان را دوباره می‌فرستند).
- تعداد آبجکت محدودیتی ندارد؛ محدودیت، حافظه است: مجموع همه مدل‌های یک اتاق حداکثر
  `MAX_ROOM_MB` مگابایت (پیش‌فرض ۲۵۰). مدلی که جا نشود فقط روی صفحه فرستنده می‌ماند.
  روی پلن رایگان Render (۵۱۲ مگابایت RAM) این عدد را بیشتر نکنید.
- حداکثر حجم هر GLB حدود ۱۰ مگابایت (به‌صورت base64 در یک پیام).
- با رفتن آخرین نفر، جلسه (اتاق) و همه مدل‌هایش پاک می‌شود.

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
- اگر هیچ admin آنلاین نباشد، بعد از `ADMIN_GRACE_SECONDS` (پیش‌فرض ۶۰) قدیمی‌ترین
  editor آنلاین (و اگر نبود، قدیمی‌ترین viewer) admin می‌شود.
- جزئیات همه پیام‌ها در سرآیند `src/ModelRoom.mjs` آمده است.

### هویت (قابل تعویض)

| متغیر | توضیح |
|---|---|
| `AUTH_PROVIDER=dev` | به `identity: { userId, name }` که کلاینت می‌فرستد اعتماد می‌کند. فقط برای توسعه؛ نیاز به `ALLOW_DEV_AUTH=true` دارد. |
| `AUTH_PROVIDER=jwt` | توکن امضاشده سایت (مثلاً BeeStoon) را بررسی می‌کند: `JWT_SECRET` (HS256) یا `JWT_PUBLIC_KEY` (RS256)، و اختیاری `JWT_ISSUER`. `sub` = شناسه، `name` = نام. |

### مسیرهای HTTP

`/convert` و `/export/fbx` فقط برای admin و editor یک جلسه زنده کار می‌کنند.
کلاینت «تیکت» شخصی‌اش را (که در `session:state` → `you.ticket` می‌آید) در هدر
`Authorization: Bearer <ticket>` می‌فرستد. نقش در لحظه بررسی می‌شود.

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
| سرور → کلاینت | `session:state` | وضعیت جلسه، شخصی برای هر نفر |
| سرور → admin | `join:request` | `{ userId, name }` |
| سرور → کلاینت | `object:list` | `{ serverId, ids }` |
| سرور → کلاینت | `object:add` / `object:transform` / `object:remove` | مثل بالا |
| سرور → فرستنده | `object:rejected` | `{ id, reason }` (حافظه پر است) |
| سرور → فرستنده | `object:denied` | `{ id, reason, transform? }` (اجازه ندارد) |
| سرور → فرستنده | `action:denied` | `{ type, reason }` |
| سرور → کلاینت | `session:notice` / `session:closed` | `{ text }` / `{ by }` |

کدهای قطع اتصال: `4101` اخراج، `4102` رد درخواست، `4103` بسته شدن جلسه،
`4104` باز شدن در پنجره دیگر.

## خروجی FBX

`POST /export/fbx?name=<نام فایل>` با بدنهٔ GLB.
پاسخ: اگر مدل تکسچر داشته باشد یک فایل ZIP (فایل FBX + تصاویر تکسچر کنار آن)،
وگرنه خود فایل FBX. تبدیل با `assimp` انجام می‌شود (بستهٔ `assimp-utils` در Dockerfile).
تکسچرها جدا گذاشته می‌شوند چون FBX با تکسچر توکار از assimp در Blender درست باز نمی‌شود.

