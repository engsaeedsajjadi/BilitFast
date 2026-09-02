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

- **انتقال:** `goTres()` (دکمه تأیید صفحه نتایج) → فرم را به `etrain/TresV.php`
  می‌فرستد. یعنی `goTres()` دقیقاً همان صفحه‌ای را باز می‌کند که **۱۳ فیلدِ
  مرحله میانی** را تولید می‌کند.
- **ارسال:** GET به `etrain/TresV.php` با همان پارامترهای جستجو + `srvc` + `departureTrain`.
- **با نشست معتبر:** صفحه خلاصه «شرکت … سفر رفت: به … جنسیت … نوع قطار …»
  که یک فرم دارد (۱۳ ورودی = فیلدهای مخفی وضعیت + انتخاب واگن/کوپه + دکمه تأیید).
- **بدون نشست:** صفحه ورود (مرحله ۰).

---

## مرحله ۳ — فرم رزرو (اطلاعات مسافر + کپچا، همزمان)

پس از انتخاب قطار، `TresV.php` یک فرم واحد برمی‌گرداند که **هم فیلدهای مسافر
و هم کپچا را با هم دارد** (برخلاف حدس اولیه، مرحله «انتخاب واگن/کوپه» جداگانه
نیست).

- **فرم:** `<form action="TresV.php" method="post" name="mainFrm">`
- **فیلدهای مسافر (با id نه name):** `pid0` (کد ملی), `ruz0` (روز تولد),
  `mah0` (ماه), `sal0` (سال), `fn0` (نام), `ln0` (نام خانوادگی),
  `phone` (موبایل), `rfood0`/`food0` (غذا — اختیاری).
- **فیلدهای وضعیت/مخفی:** `pathWay, fromd, tod, wagon, adult, shahed, child,
  infant, forien, passCnt, srvc, captchaId, adis, ajaxResponse, retSrvc,
  totalPrice, foodp, ret_foodp`.
- **Selectها:** `from`, `to`, `sex`, `food0` (مقادیر انتخاب‌شده باید ارسال شوند).

### کپچا (داخل همین فرم)

- **تصویر:** `<img id="captchaImg" src="data:image/png;base64,...">` — یعنی
  کپچا به‌صورت **data-URI** داخل HTML است، نه URL مجزا.
- **ورودی کد:** `Ksubmit` (فیلد متنی).
- **شناسه کپچا:** `captchaId` (مخفی) — همراه کد حل‌شده باید ارسال شود.
- **پاسخ AJAX:** `ajaxResponse` (مخفی).

### هندلرهای جاوااسکریپت صفحه رزرو (از onclick/onchange واقعی)

- `printmsg()` — نمایش پیام (خطا/هشدار)
- `chkForm()` / `chkForm2()` — اعتبارسنجی و ارسال فرم (احتمالاً یکی برای
  ارسال نهایی و دیگری برای بازگشت/سفارش غذا)
- endpoint جانبی: `cancleTick.php` (انصراف از بلیت)

> بنابراین جریان واقعی: فرم مسافر + کپچا را یک‌باره پر و ارسال می‌کنیم
> (POST به TresV.php). برنامه این صفحه را `captcha` طبقه‌بندی می‌کند تا
> کپچا خودکار حل شود و هم‌زمان با اطلاعات مسافر ارسال شود.

---

## مرحله ۴ — پرداخت

- **فرم پرداخت:** `<form action="/NewIPG/ProcessPayment" method="post" id="PayForm">`
- **انصراف:** `<form action="/NewIPG/CancelPayment" method="post" id="CancelPaymentForm">`
- درگاه جدید بانک (NewIPG) است؛ انتقال با POST (نه URL ساده).

---

## مرحله ۶ — پرداخت

- هدایت به درگاه بانک (شاپرک/درگاه پرداخت). فقط اینجا پنجره جدید برای کاربر باز می‌شود.

---

## خلاصه ترتیب کامل

```
ورود (UserAut.php) → جستجو (searchWagn.php GET) → انتخاب قطار
→ TresV.php (GET + srvc) → انتخاب واگن/کوپه (میانی) → کپچا (kcaptcha)
→ اطلاعات مسافر (pid/ruz/mah/sal/fn/ln + phone) → تأیید → پرداخت (درگاه بانک)
```
