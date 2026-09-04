# مهندسی معکوس جریان رزرو سایت صفیر ریل (safirrail.ir)

این سند نتیجه بررسی مستقیم صفحات عمومی سایت صفیر ریل است (با fetch صفحه، نه حدس).
هر مرحله با URL واقعی و فیلدهای لازم ثبت شده است.

---

## مرحله ۰ — ورود به سامانه (اجباری برای رزرو)

- **فرم ورود:** `fa/UserAut.php` (دارای فیلد مخفی `SiteIdValue` + دکمه submit `sublogin`)
- **endpoint ورود (POST):** `fa/Login/process.php` (action فرم = `../fa/Login/process.php`)
- **فیلدها:** `user` (شناسه), `pass` (گذرواژه), `sublogin` (دکمه), `SiteIdValue` (مخفی)
- **نتیجه:** کوکی نشست `PHPSESSID` (HttpOnly)
- ثبت‌نام: `fa/UserAut.php?Action=Register` (دارای کپچای `kcaptcha`)
- فراموشی گذرواژه: `fa/UserAut.php?Action=ForgotPassword`

**نکته حیاتی:** بدون نشست معتبر، `TresV.php` (حتی با پارامترهای کامل رزرو)
صفحه «ورود به سامانه» را برمی‌گرداند (نه redirect). بنابراین رزرو **بدون ورود ممکن نیست**.

> پیاده‌سازی: `lib/core.js → login()` ابتدا فرم ورود را GET می‌کند تا
> `SiteIdValue`/`sublogin` و کوکی نشست را از خود فرم بخواند (بدون حدس)، سپس
> POST به `fa/Login/process.php` می‌کند.

---

## مرحله ۱ — جستجوی قطار

- **فرم:** `etrain/index.php` — فیلدها: مبدا، مقصد، تاریخ رفت، تاریخ برگشت،
  جنسیت (عادی/ویژه برادران/ویژه خواهران)، تعداد بزرگسال/جانباز-شاهد/خردسال/طفل/اتباع.
- **ارسال:** GET به `etrain/searchWagn.php` با پارامترهای query-string:
  ```
  from, to, pathWay=1, fromd, tod, sex, adult, shahed, child, infant, forien,
  passCnt, srvc='', departureTrain, returnTrain, groupWay=on, tmpDate
  ```
- **نتیجه:** جدول قطارها با ستون‌ها: انتخاب، شرکت، شماره قطار، عنوان واگن، نوع،
  ظرفیت کوپه، تاریخ، ساعت، موجودی، قیمت بزرگسال.
- هر ردیف یک توکن مات `srvc` دارد (دوبار base64 شده → داده باینری/رمزنگاری‌شده؛
  نباید و لازم نیست رمزگشایی شود).

### صفحه نتایج (searchWagn.php) — ساختار فرم (از HTML واقعی گزارش کاربر)

- تابع جستجو: `searchWagon()`
- انتخاب سرویس روی کلیک ردیف: `SetSel(this, rowId, 'Tbl')` → مقدار `srvc` را set می‌کند
- دکمه تأیید: `id="srchC"` با `onclick="goTres();"`
- فیلد سرویس: `name="srvc"`

**نام فیلدهای فرم صفحه نتایج (۱۵ فیلد):**
```
from, to, groupWay, pathWay, fromd, tod, sex, wagon, adult,
shahed, child, infant, forien, passCnt, srvc
```

> ⚠️ اختلاف با `buildSearchData` فعلی:
> ۱) فرم واقعی فیلد `wagon` دارد که کد ما ارسال نمی‌کند.
> ۲) کد ما `departureTrain`/`returnTrain`/`tmpDate` را ارسال می‌کند که در لیست
>    فیلدهای فرم نیست (ولی سرور تحمل می‌کند؛ جستجو با آنها کار می‌کند).
> مقدار/معنای `wagon` هنوز تأیید نشده — بدون دیدن DOM مقدارش حدس زده نمی‌شود.

---

## مرحله ۲ — انتخاب قطار → رزرو

- **انتقال:** `goTres()` (دکمه تأیید صفحه نتایج) → `document.mainFrm.action="TresV-auth.php"`
  و submit (POST). یعنی صفحه رزرو با **POST به `etrain/TresV-auth.php`** باز می‌شود،
  نه GET به TresV.php.
- **فیلدهای ارسالی (mainFrm صفحه نتایج، ۱۵ فیلد):**
  `from, to, groupWay, pathWay, fromd, tod, sex, wagon, adult, shahed, child, infant, forien, passCnt, srvc`.
- **با نشست معتبر:** صفحه کامل رزرو (جدول مسافر pid/ruz/mah/sal/fn/ln + کپچا + قیمت).
- **بدون نشست:** صفحه ورود (مرحله ۰).

> ⚠️ GET به TresV.php فقط صفحه **ناقص** (بدون فیلد مسافر؛ «جنسیت: -» و
> «نوع قطار: -» خالی) برمی‌گرداند. نقطه ورود صحیح TresV-auth.php (POST) است.

---

## مرحله ۳ — صفحه کپچا (پس از انتخاب قطار)

`TresV.php` (GET با نشست معتبر + پارامترهای رزرو) یک صفحه «خلاصه + کپچا»
برمی‌گرداند. این صفحه **هنوز فیلد مسافر ندارد**؛ فیلدهای مسافر در مرحله بعد
(پس از ارسال کپچا) می‌آیند.

- **فیلدهای قابل‌مشاهده:** `phone` (موبایل), `foodp`/`ret_foodp` (select غذا),
  `ticPrice`/`foodPrice`/`totalPrice` (قیمت), `RadioGroup2` (رادیو).
- **فیلدهای مخفی (وضعیت سرور):** `adis`, `ajaxResponse` — این دو نشانه‌ی
  وضعیت رزرو هستند که سرور با نشست (PHPSESSID) پیگیری می‌کند؛ پارامترهای رزرو
  در اینجا دوباره ارسال نمی‌شوند.

### کپچا (به‌صورت client-side — نه تصویر، نه captchaAjax)

بررسی اسکریپت‌های inline صفحه رزرو (از لاگ واقعی کاربر) نشان می‌دهد کپچای
این صفحه **متنی و client-side** است، نه تصویری:

```js
function generate() {
  document.getElementById("Ksubmit").value = "";
  captcha = document.getElementById("image");
  var uniquechar = "";
  var randomchar = "0123456789";   // مجموعه‌کاراکتر (در لاگ ماسک شده بود)
  for (i = 1; i < 6; i++) {
    uniquechar += randomchar.charAt(Math.random() * randomchar.length);
  }
  captcha.innerHTML = uniquechar;   // متن تصادفی ۵کاراکتری در #image نمایش داده می‌شود
}
```

- **کپچا** = رشته تصادفی ۵کاراکتری که در `#image` به‌صورت **متن** نمایش داده
  می‌شود و کاربر آن را در `#Ksubmit` دوباره تایپ می‌کند.
- **اعتبارسنجی client-side:** `chkForm()` / `setPayment(isok)` — اگر کپچا
  درست باشد `paymentTbl` (جدول پرداخت) نمایش داده می‌شود؛ در غیر این صورت
  `alert('عبارت امنیتی صحیح نمیباشد')`.
- **توابع ناشناخته (در فایل .js خارجی):** `chkForm`, `chkForm2`, `setRadio`,
  `calcPrice`, `makePOSTRequest` در اسکریپت‌های inline تعریف نشده‌اند — در
  فایل‌های `.js` خارجی هستند که باید fetch شوند (diagnostics اکنون
  `externalScripts`/`jsRefs` را ثبت می‌کند).

> ⚠️ نتیجه: `captchaAjax.php` احتمالاً مربوط به **این صفحه نیست** (در
> endpoints/scripts صفحه رزرو ارجاعی به آن نیست). OCR هم ابزار درستی برای
> این مرحله نیست چون کپچا تصویری نیست. باید فایل .js خارجی که `chkForm` و
> مکانیزم ارسال فرم را تعریف می‌کند پیدا و بررسی شود.

### هندلرهای جاوااسکریپت صفحه رزرو (از onclick/onchange واقعی)

- `printmsg()` — نمایش پیام (خطا/هشدار)
- `chkForm()` / `chkForm2()` — اعتبارسنجی و ارسال فرم
- endpoint جانبی: `cancleTick.php` (انصراف از بلیت)

---

## مرحله ۳ب — فرم اطلاعات مسافر (پس از ارسال کپچا)

پس از ارسال موفق کپچا + موبایل + انتخاب غذا، `TresV.php` فرم اطلاعات مسافر را
برمی‌گرداند:

- **فیلدهای مسافر (با id نه name):** `pid0` (کد ملی), `ruz0` (روز تولد),
  `mah0` (ماه), `sal0` (سال), `fn0` (نام), `ln0` (نام خانوادگی),
  `phone` (موبایل), `rfood0`/`food0` (غذا — اختیاری).
- پس از تکمیل/تأیید این فرم → مرحله پرداخت.

---

## مرحله ۴ — تأیید رزرو → پرداخت

- **تأیید رزرو:** `chkForm()` (دکمه «ادامه/تأیید» صفحه رزرو):
  ۱) اعتبارسنجی client-side: همه مسافران `pid{i}` (کد ملی) و `fn{i}` (نام)
     پر شده باشند؛ `chkPhone()` (موبایل با `09` شروع و ≥ ۱۱ رقم).
  ۲) `document.mainFrm.action="VerifyTck.php"` و submit (POST).
- **انصراف/بازگشت:** `chkForm2()` → `document.mainFrm.action="index.php"`.
- **پاسخ VerifyTck.php:** صفحه پرداخت.
- **فرم پرداخت:** `<form action="/NewIPG/ProcessPayment" method="post" id="PayForm">`
- **انصراف پرداخت:** `<form action="/NewIPG/CancelPayment" method="post" id="CancelPaymentForm">`
- درگاه جدید بانک (NewIPG) است؛ انتقال با POST (نه URL ساده).

---

## خلاصه ترتیب کامل (تأییدشده از raja.js)

```
ورود (UserAut.php → Login/process.php POST) → جستجو (searchWagn.php) → انتخاب قطار
→ goTres(): POST TresV-auth.php (۱۵ فیلد) → صفحه رزرو (مسافر + کپچا)
→ captchaNew(): POST captchaAjax.php → «captchaId@base64PNG» → captchaImg.src
→ getInfo(): POST ajaxpid.php (pid+bdate) → «name,family» (اتوفیل نام از کد ملی)
→ chkForm(): POST VerifyTck.php → صفحه پرداخت → NewIPG/ProcessPayment
```

### توابع کلیدی raja.js (کامل)

- `goTres()` → POST `TresV-auth.php` (ورود به صفحه رزرو)
- `chkForm()` → POST `VerifyTck.php` (تأیید رزرو)
- `chkForm2()` → POST `index.php` (انصراف)
- `captchaNew()` → POST `captchaAjax.php` → `captchaId@base64` (کپچای تصویری)
- `getInfo(i)` → POST `ajaxpid.php` با `pid=...&bdate=سال+ماه+روز` → پاسخ `name,family`
- `chkPhone()` → موبایل باید `09` شروع و ≥ ۱۱ رقم
- `calcPrice()` → محاسبه foodPrice/totalPrice (مقادیر food به‌صورت `id@price`)
- `setRadio(1|2)` → جدول مسافر (۱=کد ملی، ۲=گذرنامه برای اتباع)
- `NMask()` → فقط ارقام
- `unLockTicket()`/`cancleTick.php` → انصراف بلیت (روی unload هم صدا می‌شود)
- `makePOSTRequest()` (در ajaxOut.js) → ارسال AJAX؛ پاسخ در `ajaxResponse` (hidden) قرار می‌گیرد

> فیلدهای مسافر: `pid{i}, ruz{i}, mah{i}, sal{i}, fn{i}, ln{i}` برای i=0..19،
> plus `phone`, `food{i}`, `rfood{i}`. مقدار food به‌صورت `id@price` است.
