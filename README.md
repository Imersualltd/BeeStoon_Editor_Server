# BE WATER – Multiplayer Server

سرور Colyseus برای اشتراک‌گذاری چند آبجکت GLB (هر کدام با transform خودش) بین کاربران.
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

- آبجکت‌ها و transform آن‌ها فقط در حافظه نگه داشته می‌شوند؛ با ری‌استارت سرور پاک می‌شوند
  (کلاینت‌ها بعد از وصل شدن دوباره، آبجکت‌های خودشان را دوباره می‌فرستند).
- تعداد آبجکت محدودیتی ندارد؛ محدودیت، حافظه است: مجموع همه مدل‌های یک اتاق حداکثر
  `MAX_ROOM_MB` مگابایت (پیش‌فرض ۲۵۰). مدلی که جا نشود فقط روی صفحه فرستنده می‌ماند.
  روی پلن رایگان Render (۵۱۲ مگابایت RAM) این عدد را بیشتر نکنید.
- حداکثر حجم هر GLB حدود ۱۰ مگابایت (به‌صورت base64 در یک پیام).
- رابطه «آخرین تغییر برنده است»؛ قفل یا مالکیت ندارد.

## پروتکل پیام‌ها

| جهت | پیام | داده |
|---|---|---|
| کلاینت → سرور | `object:add` | `{ id, name, dataUrl, transform? }` |
| کلاینت → سرور | `object:transform` | `{ id, position, rotation, scale }` |
| کلاینت → سرور | `object:remove` | `{ id }` |
| کلاینت → سرور | `sync-request` | `{ have: [id, ...] }` |
| سرور → کلاینت | `object:list` | `{ serverId, ids }` |
| سرور → کلاینت | `object:add` / `object:transform` / `object:remove` | مثل بالا |
| سرور → فرستنده | `object:rejected` | `{ id, reason }` |

این پروتکل جایگزین پیام‌های قدیمی `asset` و `transform` شده؛ سرور و
`network-manager.mjs` باید با هم به‌روز شوند.
