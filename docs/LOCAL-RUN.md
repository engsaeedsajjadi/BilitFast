# اجرای محلی و تست — BilitFast

راهنمای کامل اجرای پروژه روی سیستم خودتان (ویندوز/مک/لینوکس) و تست همه بخش‌ها.

---

## ۱) پیش‌نیازها

| ابزار | نسخه | بررسی |
|---|---|---|
| Node.js | ۱۸ یا بالاتر | `node -v` |
| npm | همراه نود | `npm -v` |
| git | هر نسخه اخیر | `git --version` |

اگر نود ندارید: از [nodejs.org](https://nodejs.org) نسخه LTS را نصب کنید.

---

## ۲) دریافت کد

```bash
git clone https://github.com/engsaeedsajjadi/BilitFast.git
cd BilitFast
git checkout arena/01a05742-bilitfast
npm install
```

> `npm install` ممکن است ۱ تا ۳ دقیقه طول بکشد (تِسِرَکت و وابستگی‌های تصویر).

---

## ۳) ساخت فایل `.env` (پیکربندی محلی)

در پوشه پروژه فایل `.env` بسازید (می‌توانید فایل `.env.example` را کپی کنید):

**حداقل برای شروع (همه اختیاری‌اند؛ بدون آن‌ها برنامه با حالت توسعه کار می‌کند):**

```bash
# کد فعال‌سازی محصول (دلخواه خودتان؛ برای فعال‌سازی دائمی)
BILITFAST_ACTIVATION_CODE=کد-دلخواه-شما

# کلیدها (یک‌بار بسازید و همین‌جا نگه دارید):
BILITFAST_LICENSE_KEY=CHANGE-ME
BILITFAST_TOKEN_KEY=CHANGE-ME
```

ساخت کلیدها با خود نود:

```bash
# کلید امضا (یک رشته تصادفی)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# کلید رمزنگاری توکن (دقیقاً ۶۴ کاراکتر هگز)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**گزینه‌های اختیاری (هر کدام را که می‌خواهید فعال کنید):**

```bash
# درگاه پرداخت زرین‌پال (برای فروش اشتراک)
ZARINPAL_MERCHANT_ID=test        # «test» برای سندباکس
ZARINPAL_MODE=sandbox
APP_BASE_URL=http://localhost:3000

# ربات تلگرام (اطلاع‌رسانی)
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=CHANGE-ME

# کاربران مدیر برای عملیات مدیریتی (مثلاً setup webhook)
BILITFAST_ADMIN_USERS=admin

# پیامک کاوه‌نگار
KAVENEGAR_API_KEY=
KAVENEGAR_SENDER=

# مسیر دیتابیس محلی (پیش‌فرض: پوشه data کنار پروژه)
BILITFAST_DATA_DIR=
```

> `.env` در گیت نادیده گرفته می‌شود؛ خیالتان از بابت کامیت‌نشدنش راحت باشد.

---

## ۴) اجرای برنامه

```bash
npm start
```

یا مستقیم:

```bash
node dev-server.js          # پورت ۳۰۰۰
PORT=8080 node dev-server.js  # پورت دلخواه
```

سپس در مرورگر باز کنید: **http://localhost:3000**

| صفحه | آدرس | کاربرد |
|---|---|---|
| مسیرها | `/` | تعریف مسیر جستجو و شروع پایش |
| مسیر/جستجو/رزرو | `/route.html?id=1` | جستجو، حل کپچا، رزرو، پرداخت |
| حساب کاربری | `/account.html` | ثبت‌نام/ورود، تغییر گذرواژه |
| مجوز و اشتراک | `/trial.html` | دوره آزمایشی، خرید اشتراک |
| تاریخچه رزروها | `/history.html` | رزروهای انجام‌شده و تأیید پرداخت |
| ورود صفیر ریل | `/login.html` | ورود به سامانه یا چسباندن کوکی |
| تنظیمات | `/settings.html` | اطلاع‌رسانی، حالت توسعه |

---

## ۵) تست خودکار (۹۸ تست در ۵ مجموعه)

```bash
npm test
```

اجرای هر مجموعه به‌تنهایی:

```bash
node test/classification.test.js   # طبقه‌بندی فرم‌های رزرو (۱۸)
node test/security.test.js         # توکن/لایسنس/محدودسازی (۲۵)
node test/account.test.js          # حساب/اشتراک/تاریخچه (۲۵)
node test/captcha.test.js          # پیش‌پردازش تصویر (۱۸)
node test/ml.test.js               # مدل تشخیص رقم (۱۲)
```

انتظار: هر فایل با «همه تست‌ها پاس شدند» و کد خروجی ۰ تمام شود.

---

## ۶) تست دستیِ جریان کامل (رزرو تا پرداخت)

۱. **ورود به صفیر ریل:** صفحه `/login.html` → فرم ورود را پر کنید.
   اگر ورود خودکار با کپچا مسدود شد، در مرورگر خود وارد `safirrail.ir` شوید و
   کوکی `PHPSESSID` را طبق راهنمای همان صفحه وارد کنید (بهترین روش محلی).

۲. **تعریف مسیر:** صفحه اصلی → «افزودن مسیر جدید» → مبدا/مقصد/تاریخ (با
   دیت‌پیکر شمسی) → مشخصات مسافران (کد ملی‌ها قبل از ارسال اعتبارسنجی می‌شوند).

۳. **جستجو:** «شروع جستجو» → برنامه هر ۳ ثانیه جستجو می‌کند تا ظرفیت پیدا شود
   (با پیدا شدن: نوتیفیکیشن + اطلاعیه تلگرام/پیامک در صورت پیکربندی).

۴. **رزرو:** «انتخاب» روی قطار → حل خودکار کپچا (اول مدل اختصاصی، بعد
   تِسِرَکت؛ در صورت نیاز ورود دستی) → تکمیل خودکار مسافران → باز شدن درگاه
   پرداخت → ثبت در تاریخچه و دکمه‌های تأیید نتیجه پرداخت.

> نکته مهم: جستجو از **آی‌پی سیستم خودتان** انجام می‌شود؛ اگر سامانه صفیر ریل
> آی‌پی شما را بلاک کرده باشد، خطای اتصال می‌بینید (مشکل برنامه نیست).

---

## ۷) تست APIها با خط فرمان

سرور در حال اجرا باشد؛ در یک ترمینال دیگر:

```bash
# لیست شهرها
node -e "fetch('http://localhost:3000/api/cities').then(r=>r.json()).then(d=>console.log(d.cities.length,'شهر'))"

# وضعیت مجوز (مهمان)
node -e "fetch('http://localhost:3000/api/trial',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'status'})}).then(r=>r.json()).then(console.log)"

# ثبت‌نام کاربر جدید
node -e "fetch('http://localhost:3000/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'register',username:'test1',password:'pass123'})}).then(r=>r.json()).then(d=>console.log(d.ok, d.error||''))"

# پلن‌های اشتراک
node -e "fetch('http://localhost:3000/api/subscription',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'plans'})}).then(r=>r.json()).then(d=>console.log(d.plans))"

# آمار نمونه‌های یادگیری کپچا
node -e "fetch('http://localhost:3000/api/learn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stats'})}).then(r=>r.json()).then(console.log)"
```

---

## ۸) تست حل کپچا (بدون اتصال به سایت)

```bash
# دقت مدل روی ارقام رندرشده + مسیر سریعِ مدل اختصاصی
node -e "
const {solveCaptcha}=require('./lib/captcha');
const {renderDigit}=require('./lib/digitsynth');
const {mulberry32}=require('./lib/ml');
const ops=require('./lib/imageops');
(async()=>{
  const rng=mulberry32(777);
  const parts='7291'.split('').map(d=>renderDigit(d,rng));
  const w=parts.reduce((a,p)=>a+p.width,0)+24, h=140;
  const img=ops.makeImage(w,h); let x=0;
  for(const p of parts){for(let y=0;y<p.height;y++)for(let i=0;i<p.width;i++)img.data[y*w+x+i]=p.data[y*p.width+i]; x+=p.width+8;}
  const t=Date.now(), r=await solveCaptcha(await ops.toPngBuffer(img));
  console.log('کپچا: 7291 | نتیجه:', r.text, '| روش:', r.variant, '| اطمینان:', r.confidence+'٪', '| زمان:', Date.now()-t+'ms');
})();
"
```

انتظار: `نتیجه: 7291 | روش: custom-model | اطمینان: حدود ۸۵–۹۰٪`.
اجرای اول حدود ۲ ثانیه طول می‌کشد (بارگذاری ماژول‌ها و فایل مدل)؛ در اجرای
واقعیِ سرور، حل هر کپچا با مسیر سریع چند ده میلی‌ثانیه است.

---

## ۹) آموزش/بازآموزی مدل کپچا

```bash
# آموزش از صفر (داده مصنوعی، ~۳۰ ثانیه، خروجی: دقت تست ~۹۹٪)
node train/train-digits.js

# بازآموزی با داده مصنوعی + نمونه‌های واقعی جمع‌شده از کاربران
# (نمونه‌ها در data/db.json ذخیره شده‌اند)
node train/retrain.js
```

بعد از بازآموزی، فایل `models/captcha-model.json` به‌روز می‌شود؛ برنامه بدون
هیچ کار اضافه‌ای از مدل جدید استفاده می‌کند. برای اشتراک‌گذاری با بقیه،
این فایل را کامیت کنید.

---

## ۱۰) محل داده‌ها و عیب‌یابی

| مورد | محل |
|---|---|
| دیتابیس محلی (کاربران/اشتراک‌ها/رزروها/نمونه‌های کپچا) | `data/db.json` |
| وضعیت مجوز/مسیرها/کوکی‌ها (کلاینت) | `localStorage` مرورگر |
| تنظیمات سامانه | `config.json` (بعد از تغییر: راه‌اندازی مجدد سرور) |

**مشکلات رایج:**

| مشکل | راه‌حل |
|---|---|
| `EADDRINUSE` هنگام اجرا | پورت ۳۰۰۰ مشغول است: `PORT=8080 npm start` |
| خطای اتصال به صفیر ریل | آی‌پی شما بلاک است یا سایت موقتاً قطع است؛ با مرورگر عادی چک کنید |
| فعال‌سازی کار نمی‌کند | `BILITFAST_ACTIVATION_CODE` در `.env` تنظیم نشده |
| خرید اشتراک خطای پیکربندی می‌دهد | `ZARINPAL_MERCHANT_ID` تنظیم نشده (برای تست: `test` + `ZARINPAL_MODE=sandbox`) |
| تلگرام/پیامک ارسال نمی‌شود | توکن‌های مربوطه در `.env` خالی‌اند → ارسال بی‌صدا رد می‌شود (طراحی عمدی) |
| بعد از تغییر کد، رفتار عوض نشد | سرور را متوقف (Ctrl+C) و دوباره `npm start` کنید |

برای پاک‌کردن کامل داده‌های محلی و شروع از نو: فایل `data/db.json` را حذف کنید.
