# Hardening Change Log & Deployment Notes

این سند خلاصهٔ تغییرات سخت‌سازی امنیتی اعمال‌شده روی BilitFast را ثبت می‌کند و برای deploy/review تیمی نوشته شده است.

## خلاصه

این به‌روزرسانی بدون تغییر عمده در منطق کسب‌وکار، چند ریسک مهم را می‌بندد:

- نشت کوکی بین کاربران در `api/cookie-sync`
- SSRF و نشت کوکی در مسیرهای captcha fetch/solve
- استفاده ناامن از fallback secretها در production
- دسترسی عمومی به `api/sync-cookies`
- spoof شدن webhook تلگرام و کد اتصال بدون انقضا
- data poisoning در `api/learn`
- نبود headerهای امنیتی پایه
- parsing پراکنده و شکنندهٔ JSON body
- شکنندگی نصب به‌خاطر `@tensorflow/tfjs-node`

## Change log

### 1) Cookie sync pairing

`/api/cookie-sync` دیگر mailbox عمومی نیست.

تغییرات:
- pair token کوتاه‌عمر با cookie `bf_cookie_sync_pair`
- bind شدن `push` و `poll` به همان نشست/مرورگر
- حذف رکورد پس از `poll`
- endpoint `clear` برای پاک‌کردن رکوردهای معلق
- افزونه مرورگر pair token را از همان origin برنامه خوانده و همراه درخواست push می‌فرستد

اثر عملی:
- sync افزونه فقط وقتی کار می‌کند که کاربر اول در `login.html` دکمه «دریافت کوکی از افزونه» را زده باشد
- دیگر کاربر A نمی‌تواند payload کاربر B را poll کند

### 2) SSRF hardening for reserve/captcha

برای fetch/solve تصویر کپچا فقط URLهای safirrail مجازند.

تغییرات:
- validation روی origin و scheme
- عدم ارسال cookie jar به hostهای غیرمجاز
- اجباری شدن `stateToken` برای مسیرهای captcha fetch/solve
- ذخیره hash تصویر کپچا در state برای proof یادگیری

اثر عملی:
- `captcha-image` و `solve-captcha` دیگر URL دلخواه fetch نمی‌کنند
- redirect خارجی باعث leak شدن cookie صفیر نمی‌شود

### 3) Production secret enforcement

fallback keyها فقط در development مجازند.

در production باید این متغیرها تنظیم شوند:
- `BILITFAST_LICENSE_KEY`
- `BILITFAST_TOKEN_KEY`
- `BILITFAST_ACTIVATION_CODE` (برای activation)
- `TELEGRAM_WEBHOOK_SECRET` (اگر webhook تلگرام استفاده می‌شود)

اثر عملی:
- اگر production بدون secret بالا بیاید، endpointهای مرتبط fail-safe می‌شوند

### 4) Local-only sync-cookies

`/api/sync-cookies` فقط روی loopback/localhost مجاز است.

اثر عملی:
- خواندن مستقیم کوکی Firefox/Chrome فقط در اجرای محلی معتبر است
- روی deployment عمومی این قابلیت عملاً مسدود می‌شود

### 5) Telegram hardening

تغییرات:
- `setWebhook` با `secret_token`
- verify هدر `x-telegram-bot-api-secret-token`
- طول بیشتر برای connect code
- expiry برای connect code
- `setup-webhook` فقط برای adminها

متغیرهای جدید:
- `TELEGRAM_WEBHOOK_SECRET`
- `BILITFAST_ADMIN_USERS`

اثر عملی:
- برای setup webhook در production باید کاربر لاگین‌شده داخل لیست admin باشد
- کدهای قدیمی اتصال دیگر دائمی نیستند و بعد از مدت کوتاه منقضی می‌شوند

### 6) Captcha learning proof

`/api/learn` فقط وقتی نمونه را می‌پذیرد که سرور proof token زمان‌دار صادر کرده باشد.

تغییرات:
- `learnToken` امضاشده و زمان‌دار
- تطبیق `text` و `image_hash`
- جلوگیری از replay با `proof_id`

اثر عملی:
- submit دستی نمونه بدون proof دیگر پذیرفته نمی‌شود
- prototype poisoning سخت‌تر شده است

### 7) Security headers + storage reduction

تغییرات:
- افزودن CSP, Referrer-Policy, X-Content-Type-Options, X-Frame-Options, Permissions-Policy
- اعمال در `dev-server.js` و `vercel.json`
- انتقال cache موقت لایسنس از `localStorage` به `sessionStorage`

اثر عملی:
- سطح حمله XSS کاهش یافته، هرچند مسیرهای اصلی هنوز به خاطر نیاز محصول از storage سمت کلاینت استفاده می‌کنند

### 8) Shared JSON parsing + dependency cleanup

تغییرات:
- ساخت helper مشترک `lib/http.js`
- جایگزینی parsingهای تکراری با `readJsonBody`
- انتقال `@tensorflow/tfjs-node` به `optionalDependencies`
- افزودن `.env.example`

اثر عملی:
- نصب پروژه در محیط‌هایی که دانلود باینری tfjs-node مشکل دارد شکننده‌تر از قبل نیست
- behavior endpointها یکنواخت‌تر شده است

## فایل‌های مهم تغییرکرده

- `api/cookie-sync.js`
- `api/sync-cookies.js`
- `api/learn.js`
- `api/telegram-webhook.js`
- `api/notify.js`
- `api/reserve.js`
- `lib/reserve.js`
- `lib/token.js`
- `lib/license.js`
- `lib/auth.js`
- `lib/notify.js`
- `lib/http.js`
- `public/login.html`
- `public/route.html`
- `extension/background.js`
- `vercel.json`
- `.env.example`
- `test/hardening.test.js`

## تنظیمات موردنیاز production

نمونه:

```env
BILITFAST_ACTIVATION_CODE=...
BILITFAST_LICENSE_KEY=...
BILITFAST_TOKEN_KEY=...
APP_BASE_URL=https://your-app.example.com

TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
BILITFAST_ADMIN_USERS=admin1,admin2
```

توصیه:
- `BILITFAST_TOKEN_KEY` باید 64 کاراکتر hex باشد
- `BILITFAST_LICENSE_KEY` و `TELEGRAM_WEBHOOK_SECRET` تصادفی و بلند باشند
- در production حتماً HTTPS فعال باشد

## نکات عملیاتی بعد از deploy

### اگر از افزونه cookie sync استفاده می‌کنید
- کاربر باید اول `login.html` را باز کند
- روی «دریافت کوکی از افزونه» بزند
- سپس در همان مرورگر روی آیکون افزونه کلیک کند
- آدرس ذخیره‌شده در تنظیمات افزونه باید دقیقاً با آدرس برنامه یکی باشد

### اگر از webhook تلگرام استفاده می‌کنید
- `APP_BASE_URL` باید public و صحیح باشد
- `TELEGRAM_WEBHOOK_SECRET` باید تنظیم شود
- کاربر admin باید `setup-webhook` را اجرا کند

### اگر از sync مستقیم مرورگر استفاده می‌کنید
- فقط روی `localhost` / `127.0.0.1` کار می‌کند
- روی deployment عمومی عمداً blocked است

## Compatibility notes

این hardening برای حفظ منطق فعلی طراحی شده و تست‌های موجود + تست‌های جدید پاس شده‌اند.

تنها تغییرات رفتاری قابل‌مشاهده برای کاربر:
- sync افزونه نیاز به initiation از صفحه login دارد
- connect code تلگرام زمان‌دار شده است
- `sync-cookies` بیرون از localhost دیگر کار نمی‌کند
- sample learning خام و بدون proof پذیرفته نمی‌شود

## Validation

تست اجراشده:

```bash
npm test
```

شامل تست‌های جدید برای:
- cookie-sync isolation
- SSRF blocking
- webhook secret enforcement
- learn proof enforcement
- production secret enforcement
