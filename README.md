# BilitFast Web 3.13.2 — اصلاح توقف فوری جستجو

**رفع اشکال 3.13.2:** حذف race condition ذخیره‌سازی رمزشده که باعث می‌شد جستجو بلافاصله پس از شروع متوقف شود؛ تست‌های Windows برای صفحه ورود نیز اصلاح شده‌اند. [جزئیات و دستورات تست](docs/FIX-3.13.2-FA.md).

**هر نصب مستقل یک حساب مالک و فقط یک نشست فعال دارد.** نسخه‌های 3.13.1 به بعد برای نصب‌های جدید، شناسه نصب را به اثر انگشت میزبان متصل می‌کند و در صورت کپی اطلاعات به یک میزبان متفاوت مجوز را نمی‌پذیرد. این سازوکار روی سروری که خریدار کنترل کامل آن را دارد DRM غیرقابل دورزدن نیست. برای Docker، روش پشتیبانی‌شده قفل میزبان روی **Linux host** با mount فقط‌خواندنی `/etc/machine-id` است؛ Docker Desktop روی Windows نیازمند طراحی استقرار میزبان متناسب دارد و با همین فایل Compose گواهی نشده است.

در پاسخ جستجوی HTTP 200، صفحات ورود، کپچا و پاسخ HTML نامعلوم «ظرفیت صفر» به‌شمار نمی‌آیند. رزرو خودکار هرگز اولین قطار را به‌جای شماره انتخاب‌شده جایگزین نمی‌کند. تست‌ها: `npm test`، `npm run audit:security`، `npm run test:enterprise`.

**نکته تحویل:** فایل `config/license-public.pem` باید از کلید خصوصی **موجود** فروشنده بازیابی شود؛ در سورس ارسالی نبود. بدون این فایل، فعال‌سازی دائم کار نمی‌کند. روی رایانه فروشنده دستور `node scripts/license-admin.js init` را تنها پس از اطمینان از وجود کلید خصوصی قدیمی اجرا کنید؛ از تولید جفت‌کلید تصادفی جایگزین برای لایسنس‌های قبلی خودداری کنید. سپس `npm run check:delivery` را اجرا کنید. کلید خصوصی فروشنده را در ZIP مشتری قرار ندهید.

مهاجرت نصب‌های قدیمی `installation.json` نسخه ۱ خودکار انجام نمی‌شود و برای جلوگیری از فعال‌شدن نسخه کپی‌شده، تا تأیید و مهاجرت با کد امضاشده اختصاصی فروشنده مسدود است؛ مستندات `docs/DELIVERY-3.13.1-FA.md` و [راهنمای نصب تک‌مالک](docs/SINGLE-OWNER-3.13-FA.md) را ببینید.

# BilitFast Web 3.12.2 — اصلاح ماندگاری الگوهای مسافر

الگوهای مسافر در همان مرورگر و همان آدرس BilitFast پس از بسته‌شدن و بازشدن برنامه باقی می‌مانند. ایراد خالی‌ماندن فهرست الگوها در مسیر جدید، ناشی از بارگذاری قبل از رمزگشایی، اصلاح شد؛ نوشتن‌های معوق نیز پیش از پیام موفقیت انتظار کشیده می‌شوند. شماره همراه جزو الگو نیست. تست: `npm run test:passenger-profiles`. راهنما: [`docs/PASSENGER-PROFILES-PERSISTENCE-3.12.2-FA.md`](docs/PASSENGER-PROFILES-PERSISTENCE-3.12.2-FA.md).

---

# BilitFast Web 3.12.0 — رزرو در تب جدید، BilitFast همیشه در دسترس

در نسخه 3.12 با کلیک روی «انتخاب و تأیید ربات» در ردیف قطار، افزونه یک **تب جدید** در همان پنجره مرورگر برای صفحه رسمی `safirrail.ir` می‌سازد. تب اصلی BilitFast با فرم و نتایج جستجو بدون تغییر باز می‌ماند تا در صورت خرابی/انقضای صفحه رزرو، کاربر به برنامه برگردد. پنل کناری دارای دکمه‌های «نمایش تب رزرو» و «بازگشت به تب BilitFast» است.

کپچای واقعی فقط در صفحه رسمی سفیر ریل اجرا می‌شود و کاربر آن را خودش تأیید می‌کند؛ افزونه کپچا را حل یا کلیک نمی‌کند و توکن تولید یا بازپخش نمی‌کند. ادامه خودکار مراحل عادی رزرو فقط در صورت تطابق اطلاعات با فرم اولیه انجام می‌شود. پرداخت دستی است.

**راه‌اندازی:** `npm ci` سپس `npm run preview:web`. در `chrome://extensions` نسخه‌های قبلی را غیرفعال و پوشه `extension` نسخه **3.13.2** را با Load unpacked بارگذاری کنید، سپس تب BilitFast را Refresh کنید. تست‌ها: `npm run test:new-tab`، `npm run test:official-handoff` و `npm test`.

**راهنما و محدودیت‌ها:** [`docs/NEW-TAB-BOOKING-3.12-FA.md`](docs/NEW-TAB-BOOKING-3.12-FA.md). تست زنده عملکرد سفیر ریل، پذیرش نشست و پرداخت هنوز لازم است.

---

# BilitFast Web 3.11.0 — رفع توقف دکمه انتخاب قطار

**این بسته فقط سورس وب + افزونه است، نه نسخه WebView2.** در نسخه 3.10، انتخاب قطار ابتدا `POST /api/reserve?action=start` را روی سرور مشتری اجرا می‌کرد؛ اگر تأیید نشست/اتصال به SafirRail شکست می‌خورد، دستور بازشدن صفحه رسمی هرگز ارسال نمی‌شد. در 3.11 مسیر `prepare-official-handoff` صرفاً فرم انتخاب‌شده را از داده‌های ثبت‌شده می‌سازد؛ مرورگر **با کوکی نشست خودش** درخواست اصلی را روی مبدأ رسمی SafirRail انجام می‌دهد و کپچا را به کاربر نشان می‌دهد.

- فقط یک کلیک روی «انتخاب و تأیید ربات»؛ هیچ کلیکی روی چک‌باکس ARCaptcha یا بازپخش توکن وجود ندارد.
- اگر پنل Chrome باز نشود، مسیر رسمی متوقف نمی‌شود؛ می‌توان پنل را دستی باز کرد.
- در صورت قدیمی‌بودن نتایج، مرورگر وارد مرحله رسمی می‌شود؛ سایت اصلی می‌تواند ظرفیت یا قیمت را رد کند.
- افزونه باید **3.11.0** باشد؛ نسخه‌های قدیمی را غیرفعال کنید، `Load unpacked` کنید و صفحه BilitFast را Refresh نمایید.
- اگر اسکریپت افزونه در تب مسیر فعال نباشد، خطای دقیق نمایش داده می‌شود؛ دیگر دکمه بی‌واکنش نمی‌ماند.
- استقرار تجاری نیازمند اعتبارسنجی زنده، HTTPS و رعایت شرایط سرویس سفیر ریل است. موفقیت روی حساب واقعی هنوز تضمین نشده است.

تست هدفمند: `npm run test:selection-regression`، سپس `npm run test:official-handoff`، و در صورت نصب وابستگی‌ها `npm test`.

راهنمای جزئیات: `docs/FIRST-PARTY-ONE-CLICK-3.11-FA.md`.

---

# BilitFast Web 3.10.0 — اتصال مستقیم از تب سفیر ریل (بدون کد)

**نسخه فعلی برای آزمایش:** افزونه را فقط از تب رسمی `https://safirrail.ir/etrain/` اجرا کنید؛
یک تب BilitFast (`http://127.0.0.1:3000` در توسعه یا دامنه HTTPS آژانس) را **در همان پنجره** باز نگه دارید.
با یک بار کلیک روی «اتصال نشست به BilitFast»، بعد از تأیید مجوز همان دامنه،
نشست مستقیماً در `sessionStorage` **همان تب BilitFast** نوشته و بازخوانی می‌شود.
**هیچ کد شش‌رقمی، Poll یا ارسال کوکی به API واسط انجام نمی‌شود.**

این قابلیت فقط با **اجازه آگاهانه صاحب حساب** استفاده شود. کوکی نشست، اعتبارنامه حساس است؛
فقط به دامنه تحت کنترل و مورد اعتماد خود مجوز دهید. مقدار کوکی‌ها در خروجی یا گزارش افزونه
ثبت نمی‌شود، اما در نسخه فعلی API جستجوی BilitFast ممکن است خود نشست را به بک‌اند همان نصب ارسال کند.
پذیرش واقعی نشست توسط سفیر ریل و کارکرد روی محیط مشتری تضمین نشده و باید عملی تست شود.
از روی وضعیت «ذخیره شد» نباید نتیجه گرفت که حساب رزرو واقعاً تأیید شده است.
ARCaptcha همچنان فقط در دامنه رسمی و توسط انسان تأیید می‌شود.

راهنما: [`docs/DIRECT-TAB-CONNECTION-3.10-FA.md`](docs/DIRECT-TAB-CONNECTION-3.10-FA.md)

---

## تاریخچه نسخه‌های قبلی (روش PIN شش‌رقمی فقط برای نسخه‌های قدیمی)

## BilitFast Web 3.9.0 — رفع انتظار اتصال و اتصال با یک کلیک

در Chrome/Edge ابتدا در `https://safirrail.ir/etrain/` وارد حساب خود شوید، سپس
`http://127.0.0.1:3000/login.html` (در نصب مشتری، دامنه HTTPS متعلق به آژانس) را
باز کنید. صفحه کد موقت را خودکار ایجاد می‌کند. **از همان تب** افزونه BilitFast 3.9.0
را باز کنید و «اتصال امن با یک کلیک» را بزنید. کپی‌کردن و واردکردن کد لازم نیست؛
کد دستی فقط برای بازیابی خطاست. پس از تحویل و ذخیره موفق، صفحه فوراً نتیجه را
نشان می‌دهد و منتظر تأیید آنلاین سفیر ریل نمی‌ماند.

**امنیت و محدودیت:** این روش هنوز یک انتقالِ حساسِ کوکی به سرور همان آژانس است.
فقط با رضایت کاربر و روی مقصد معتبر/مورد اعتماد استفاده شود. «کوکی منتقل شد»
هرگز به معنی «سفیر ریل ورود یا رزرو را پذیرفت» نیست. در مرحله رزروِ رسمی،
مرورگر خود نشست first-party را اعمال می‌کند؛ ARCaptcha فقط توسط انسان روی
مبدأ رسمی انجام می‌شود. برای نسخه عمومی/سازمانی، کنارگذاشتن کامل انتقال کوکی و
استفاده از ادغام رسمی یا عملیات صرفاً مرورگری توصیه می‌شود. امکان تضمین عمر
یا پذیرش کوکی توسط سامانه ثالث وجود ندارد.

جزئیات و عیب‌یابی: [`docs/ONE-CLICK-SESSION-3.9-FA.md`](docs/ONE-CLICK-SESSION-3.9-FA.md)

---

# BilitFast Web 3.8.0 — one-click train selection and retryable cookie transfer

For the current customer experience and safety limits, see `docs/ONE-CLICK-COOKIE-RESERVATION-3.8-FA.md`. The sections below retain earlier version notes.

## Previous 3.7 behavior — faster post-CAPTCHA reservation flow

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


## تاریخچه منسوخ: جریان ARCaptcha در یک تب (افزونه 3.4.0 — قابل استفاده در نسخه جدید نیست)

**این بخش صرفاً تاریخچه است. در نسخه فعلی رزرو در تب جدید انجام می‌شود.** در نسخه قدیمی پس از شروع رزرو با افزونه، تب BilitFast به صفحه رسمی رزرو در **همان تب** می‌رود و پنل کناری BilitFast باز می‌ماند؛ هیچ تب جدیدی باز نمی‌شود. خود ویجت در دامنه سفیر ریل و فقط با تأیید انسانی کاربر اجرا می‌شود. انتقال ویجت به DOM دامنه BilitFast بدون اتصال رسمی ممکن نیست. راهنما: `docs/SINGLE-TAB-FIRST-PARTY-CAPTCHA-FA.md`.


## تاریخچه منسوخ: جریان ساده رزرو — نسخه وب 3.8

- پس از اتصال اولیه حساب سفیر ریل با کد یک‌بارمصرف، دکمه ردیف قطار **«انتخاب و تأیید ربات»** است. نیازی به بازکردن دوباره پنجره افزونه برای شروع مرحله رسمی نیست.
- اگر پیام تحویل نشست در شبکه گم شود، دریافت همان کد تا پیش از تأیید ذخیره در مرورگر قابل تکرار است. پس از ذخیره، فراخوانی `ack` رکورد رمزگذاری‌شده را حذف می‌کند؛ در غیر این صورت حداکثر تا ۵ دقیقه حذف می‌شود.
- شروع مستقیم از جدول نتایج فقط روی **همان دامنه BilitFast** فعال می‌شود که کاربر قبلاً در افزونه اجازه داده و نشست را به آن ارسال کرده است.
- پنل افزونه و صفحه مسیر فقط گزینه‌های خطایابی را در بخش قابل بازکردن نشان می‌دهند. چک‌باکس ARCaptcha، توکن‌های آن و اطلاعات پرداخت خودکار پردازش نمی‌شوند.
- اولین اتصال پس از به‌روزرسانی افزونه به 3.8 ممکن است لازم باشد دوباره انجام شود تا مجوز مربوط به دکمه انتخاب قطار ثبت شود.

این تغییرات، اجرای واقعی روی سامانه و دسترسی قطعی به درگاه را تضمین نمی‌کنند.


## Search retry policy (3.12.1)

Valid empty inventory does **not** count as a network failure. Only explicit network/timeouts, HTTP 429 throttling and specific transient server failures use exponential backoff. Authentication/CAPTCHA requirements stop for human action. See `docs/SEARCH-RESULTS-AND-RETRY-POLICY-3.12.1-FA.md`.


## یادداشت انتشار 3.13.3

اصلاح تشخیص وضعیت ظرفیت و متن‌های مبهم جستجو: مستند `docs/CHANGELOG-3.13.3-FA.md` را ببینید.
