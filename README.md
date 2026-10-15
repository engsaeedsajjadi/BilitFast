# BilitFast Web 3.7.0 — faster post-CAPTCHA reservation flow

**One confirmation, at booking start:** When the user clicks **Start Booking** in BilitFast, they authorize normal intermediate train/passenger/allocated-coupe steps to continue **automatically** in the same official SafirRail browser tab. There is no second consent prompt for passenger filling or for the exact recognized allocated-seat acknowledgement. **The user must still complete ARCaptcha manually on `https://safirrail.ir`, and must personally complete the bank payment.** No widget DOM migration, CAPTCHA token access, checkbox automation, fake checkout URL or payment automation is implemented.

After SafirRail genuinely advances past the human CAPTCHA to the passenger form, the extension fills the pre-entered passenger details, checks exact field values, and invokes only the unique official `chkForm()` control. Once the official page provides the *specific allocated wagon/coupe acknowledgement* and a unique recognized continuation control, the extension can check **that ordinary booking acknowledgement** and proceed using the site's own form. A contradictory service/wagon marker, edited passenger data, unknown page/control, expired request, or changing site HTML **stops automation**. Each step can be claimed at most once for the same tab and booking; the allocated-coupe claim is limited to two minutes after passenger confirmation. If SafirRail shows no verifiable booking identity or has different labels, manual handling is required.

**Important:** The acknowledgement checkbox for assigned seating is NOT the ARCaptcha checkbox. The official bank page is never clicked by the extension. The current source has NOT been verified against SafirRail's live booking HTML or gateway; unit tests alone cannot guarantee a successful checkout.

Details: `docs/AUTO-CHECKOUT-AFTER-HUMAN-CAPTCHA-2026-10-15-FA.md`. Run `npm run test:official-handoff` and `npm test`.

---

## BilitFast 3.6 — automatic passenger fill with human-only CAPTCHA

The official `safirrail.ir` reservation is displayed **in the same Chrome/Edge tab**, with the BilitFast side panel. A web site cannot create an actual cross-origin WebView with the official widget under its own domain; a native shell could show a first-party page, but would be a separate desktop distribution.

After SafirRail itself advances from the human-operated CAPTCHA to the passenger form, BilitFast fills matching blank fields from the previously supplied booking data **automatically**, with no second prompt. It never overwrites conflicting human edits. A tightly bounded intermediary train/coupe action may be clicked only when the official first-party DOM has exactly one explicit `type=button` control with an exact train/coupe confirmation label **and** the official page's `srvc`/`wagon` marker matches the previous BilitFast selection. Missing/ambiguous markers or controls require manual handling. No CAPTCHA checkbox/token access, challenge submit, passenger final submit, purchase confirmation or bank payment is automated. Live DOM selectors and checkout require authorized real-browser testing.

See `docs/AUTO-PASSENGER-FIRST-PARTY-2026-10-15-FA.md` and `npm run test:official-handoff`.

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


## جریان ساده رزرو — نسخه وب 3.8

- پس از اتصال اولیه حساب سفیر ریل با کد یک‌بارمصرف، دکمه ردیف قطار **«انتخاب و تأیید ربات»** است. نیازی به بازکردن دوباره پنجره افزونه برای شروع مرحله رسمی نیست.
- اگر پیام تحویل نشست در شبکه گم شود، دریافت همان کد تا پیش از تأیید ذخیره در مرورگر قابل تکرار است. پس از ذخیره، فراخوانی `ack` رکورد رمزگذاری‌شده را حذف می‌کند؛ در غیر این صورت حداکثر تا ۵ دقیقه حذف می‌شود.
- شروع مستقیم از جدول نتایج فقط روی **همان دامنه BilitFast** فعال می‌شود که کاربر قبلاً در افزونه اجازه داده و نشست را به آن ارسال کرده است.
- پنل افزونه و صفحه مسیر فقط گزینه‌های خطایابی را در بخش قابل بازکردن نشان می‌دهند. چک‌باکس ARCaptcha، توکن‌های آن و اطلاعات پرداخت خودکار پردازش نمی‌شوند.
- اولین اتصال پس از به‌روزرسانی افزونه به 3.8 ممکن است لازم باشد دوباره انجام شود تا مجوز مربوط به دکمه انتخاب قطار ثبت شود.

این تغییرات، اجرای واقعی روی سامانه و دسترسی قطعی به درگاه را تضمین نمی‌کنند.
