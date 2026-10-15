# BilitFast Web — first-party ARCaptcha review (extension 3.5.0)

**Supported path:** official `https://safirrail.ir/etrain/` page in the **same browser tab**, with a BilitFast Chrome/Edge side panel and small first-party-page helper. ARCaptcha stays at SafirRail's origin; the user completes the checkbox and presses the site's own confirmation button. The extension does **not** read widget response values, click its controls, synthesize/replay CAPTCHA tokens, auto-submit the CAPTCHA form, or auto-submit passenger confirmation. Passenger fields are filled only after a separate user click.

On Chrome/Edge, open BilitFast, select a route and start the reservation with the extension. The side panel stays visible while the existing tab navigates to the official domain. The browser's first-party session is used. If you require the address bar to remain on BilitFast's domain with the genuine ARCaptcha displayed inside it, that is **not supported** without formal SafirRail/ARCaptcha domain authorization and compatible embedding policy.

**Before commercial release:** test with a SafirRail-authorized account, validate the exact passenger form and checkout transitions, and review cookie-transfer risks, package vulnerabilities, self-hosted license tamper resistance and JSON database scaling. No automated test proves that the live SafirRail server accepted a challenge or completed payment.

Tests: `npm run test:official-handoff`, `npm test` (with dependencies installed). Security review and UI states: `docs/ARCAPTCHA-FIRST-PARTY-SECURITY-REVIEW-2026-10-15.md`. For the legacy operating model and independent installation, see `docs/SELFHOST-WEB-SELLER-FA.md`.

**افزونه تأیید انسانی یکپارچه 3.3.0:** راهنما در `docs/INTEGRATED-ARCAPTCHA-WORKSPACE-FA.md`

# BilitFast Web Self-Hosted — نسخه تحت وب قابل نصب روی هاست خریدار

این نسخه روی سرور **خود آژانس** اجرا می‌شود، نه سرور فروشنده. کاربران فقط به آدرس HTTPS مراجعه می‌کنند. Electron و EXE لازم نیست.

شروع سریع:

```bash
docker run --rm -v "$PWD:/work" -w /work node:22-alpine node scripts/setup-selfhost.js agency.example.com
docker compose -f compose.selfhost.yml up -d --build
```

دامنه باید از قبل روی IP سرور تنظیم شده باشد و پورت‌های ۸۰ و ۴۴۳ باز باشند. برای راه‌اندازی مدیر اولیه به `/admin.html` و برای دریافت شناسه لایسنس به `/trial.html` بروید.

**مستندات کامل، محدودیت‌های عملیات رزرو و راهنمای فروش:** `docs/SELFHOST-WEB-SELLER-FA.md`.

مهم: عرضه این بسته به‌معنی تضمین عملیات رزرو سفیر ریل نیست. کد انتقال نشست از طریق افزونه، نیازمند تست واقعی و رضایت صاحب حساب است. مجوز آفلاین روی سروری که کاملاً در اختیار خریدار است، ضد‌دستکاری مطلق نیست.

**افزونه اتصال نسخه وب 3.1.0:** آدرس از تب فعال BilitFast شناسایی می‌شود؛ برای تست محلی `http://127.0.0.1:3000` و برای مشتری فقط HTTPS. دستور تست: `npm run test:web-extension`. راهنما: `docs/WEB-EXTENSION-FIX-2026-10-14-FA.md`.


### رزرو با ARCaptcha در نسخه وب

افزونه نسخه **3.2.0** گردش‌کار تأیید انسانی در تب رسمی سفیر ریل و پرکردن اطلاعات مسافر را فراهم می‌کند؛ کد ضدربات خودکار حل نمی‌شود. جزئیات: `docs/WEB-ARCAPTCHA-FIRST-PARTY-FA.md`.


## بهبود جریان ARCaptcha در یک تب (افزونه 3.4.0)

پس از شروع رزرو با افزونه، تب BilitFast به صفحه رسمی رزرو در **همان تب** می‌رود و پنل کناری BilitFast باز می‌ماند؛ هیچ تب جدیدی باز نمی‌شود. خود ویجت در دامنه سفیر ریل و فقط با تأیید انسانی کاربر اجرا می‌شود. انتقال ویجت به DOM دامنه BilitFast بدون اتصال رسمی ممکن نیست. راهنما: `docs/SINGLE-TAB-FIRST-PARTY-CAPTCHA-FA.md`.
