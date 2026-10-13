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

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- یا از `Dockerfile` استفاده کنید.

بعد از استقرار، آدرس HTTPS سرویس (مثلاً `https://be-water.onrender.com`)
را در attribute **Server Url** روی entity `NetworkManager` بگذارید.

## محدودیت‌ها

- مدل و transform فقط در حافظه نگه داشته می‌شوند؛ با ری‌استارت سرور پاک می‌شوند.
- حداکثر حجم GLB حدود ۱۰ مگابایت (به‌صورت base64 در یک پیام).
- مدل رابطه «آخرین تغییر برنده است»؛ قفل یا مالکیت ندارد.
