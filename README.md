# BE WATER – Multiplayer Server

سرور Colyseus برای اشتراک‌گذاری مدل GLB و transform آن بین کاربران.
با کلاینت `network-manager.mjs` در پروژهٔ PlayCanvas کار می‌کند.

## اجرای محلی (برای تست)

```bash
npm install
npm start
```

بعد در مرورگر `http://localhost:2567` را باز کنید. باید `{"ok":true,...}` ببینید.

## استقرار روی سرور ابری

هر سرویسی که Node.js 20 و WebSocket را پشتیبانی کند جواب می‌دهد.
پورت را سرویس از طریق متغیر `PORT` می‌دهد و کد خودش آن را می‌خواند.

- روی Render سرویس به‌صورت **Docker** اجرا می‌شود (`render.yaml` و `Dockerfile`)،
  چون خروجی FBX به ابزار `assimp` نیاز دارد که در Docker image نصب می‌شود.
- Health check: `/health`

بعد از استقرار، آدرس HTTPS سرویس (مثلاً `https://be-water.onrender.com`)
را در attribute **Server Url** روی entity `NetworkManager` بگذارید.

## محدودیت‌ها

- مدل و transform فقط در حافظه نگه داشته می‌شوند؛ با ری‌استارت سرور پاک می‌شوند.
- حداکثر حجم GLB حدود ۱۰ مگابایت (به‌صورت base64 در یک پیام).
- مدل رابطه «آخرین تغییر برنده است»؛ قفل یا مالکیت ندارد.

## خروجی FBX

`POST /export/fbx?name=<نام فایل>` با بدنهٔ GLB.
پاسخ: اگر مدل تکسچر داشته باشد یک فایل ZIP (فایل FBX + تصاویر تکسچر کنار آن)،
وگرنه خود فایل FBX. تبدیل با `assimp` انجام می‌شود (بستهٔ `assimp-utils` در Dockerfile).
تکسچرها جدا گذاشته می‌شوند چون FBX با تکسچر توکار از assimp در Blender درست باز نمی‌شود.

