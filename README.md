# Bilit Fast — نسخه تحت وب

تبدیل برنامه دسکتاپی **BilitFast.py** (PyQt5 / ویندوز) به یک وب‌اپ **Flask** با حفظ منطق اصلی.

## تغییرات انجام‌شده نسبت به نسخه دسکتاپ

| بخش | نسخه دسکتاپ (ویندوز) | نسخه تحت وب |
|---|---|---|
| رابط کاربری | PyQt5 | HTML/CSS/JS (RTL، فارسی) |
| دوره آزمایشی | رجیستری ویندوز (`winreg`) | فایل `trial.json` |
| ذخیره وضعیت مسیرها | `QSettings` | فایل `state.json` |
| ورود به سامانه | خواندن کوکی Firefox (`browser_cookie3`) | صفحه ورود داخلی `/login` |
| رزرو نهایی | بازکردن Firefox + چسباندن خودکار با `pyautogui`/`pyperclip` | دانلود فایل فرم HTML + نمایش مشخصات مسافران |
| اجرای پس‌زمینه جستجو | `QThreadPool` / `QRunnable` | `threading.Thread` |

**منطق بدون تغییر** (پورت مستقیم از `BilitFast.py`):
- ساخت داده جستجو (`_build_search_data`)
- استخراج قطارها با `lxml` و سِلکتورهای `config.json` (`extract_trains`)
- ارسال درخواست با retry و backoff (`_send_request`)
- محدودسازی نرخ درخواست (`DynamicRateLimiter`)
- نشست (`SessionSingleton`) و ریت‌لیمیتر
- تولید فرم HTML رزرو (POST به `TresV.php`)

## ساختار

```
web/
  app.py          ← اپ Flask (مسیرها و API)
  core.py         ← منطق اصلی (پورت از BilitFast.py)
  templates/      ← قالب‌های HTML
  static/         ← CSS
config.json       ← تنظیمات (سِلکتورها، آدرس‌ها، ورود)
cities.json       ← کد شهرها
requirements.txt
```

## اجرا

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
cd web
../.venv/bin/python app.py
```

سپس در مرورگر: http://127.0.0.1:5000

## استقرار (Deploy)

این برنامه یک سرور Flask طولانی‌مدت است (جستجوی پس‌زمینه با thread و polling مداوم)،
بنابراین **روی Vercel/Netlify (serverless) کار نمی‌کند**. از یک هاست پایتون استفاده کنید:

### Render.com (پیشنهادی)
1. ریپو را در Render «New + → Blueprint» اضافه کنید (فایل `render.yaml` موجود است) یا سرویس Web Service با `runtime: python` بسازید.
2. دستورها به‌صورت خودکار تنظیم می‌شوند:
   - **Build:** `pip install -r requirements.txt`
   - **Start:** `gunicorn --chdir web --bind 0.0.0.0:$PORT app:app`

### Railway
- از «Deploy from GitHub repo» استفاده کنید (فایل `Procfile` و `requirements.txt` موجود است).

### Fly.io / Docker
- فایل `Dockerfile` موجود است:
  ```bash
  fly launch
  # یا
  docker build -t bilitfast . && docker run -p 5000:5000 bilitfast
  ```

### ⚠️ نکته درباره ذخیره‌سازی وضعیت
`trial.json` و `state.json` روی دیسک سرویس ذخیره می‌شوند. در پلن‌های رایگان Render/Railway
دیسک **موقتی (ephemeral)** است و با هر ری‌استارت/ری‌دپلوی پاک می‌شود (دوره آزمایشی و
مسیرهای ذخیره‌شده از بین می‌روند). برای ماندگاری، یک **Persistent Disk** (در Render) یا
**Volume** (در Railway/Fly) به مسیر پروژه متصل کنید.

## نکات مهم

### ۱. ورود به سامانه
برنامه دسکتاپی کوکی‌های Firefox را می‌خواند؛ این کار در وب ممکن نیست. بنابراین صفحه
`/login` اضافه شده که مستقیماً به سامانه صفیر ریل POST می‌زند. نام فیلدهای فرم ورود
(`user` / `pass`) و آدرس ورود قابل تنظیم است و در `config.json` یا از منوی «تنظیمات»
قابل ویرایش می‌باشد. اگر ورود کار نکرد، مقادیر را مطابق فرم واقعی سایت اصلاح کنید:

- `login_url` — مسیر فرم ورود
- `login_action` — مقدار پارامتر `Action`
- `login_user_field` / `login_pass_field` — نام فیلدهای شناسه/گذرواژه
- `login_success_marker` — متنی که در پاسخِ موفقیت‌آمیز ورود ظاهر می‌شود (برای تشخیص ورود موفق)

### ۲. رزرو نهایی
در نسخه دسکتاپ، پس از یافتن قطار، Firefox با یک فایل HTML فرم باز می‌شد و اطلاعات
مسافران با `pyautogui` به‌صورت خودکار چسبانده می‌شد. در وب این امکان وجود ندارد؛
بنابراین:
- همان فایل فرم HTML تولید و برای **دانلود** ارائه می‌شود.
- کاربر فایل را در مرورگر خود باز می‌کند تا به صفحه رزرو سایت هدایت شود.
- مشخصات مسافران در همان صفحه نمایش داده می‌شود تا کاربر به‌صورت دستی وارد کند.

### ۳. توجه حقوقی/اخلاقی
این برنامه برای رزرو خودکار/مانیتورینگ ظرفیت قطار ساخته شده است. لطفاً مطابق قوانین
و شرایط استفاده سایت صفیر ریل از آن استفاده کنید و از فشار بیش از حد به سرورها پرهیز
نمایید.
