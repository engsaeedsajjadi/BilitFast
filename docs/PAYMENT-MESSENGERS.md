# ارسال خودکار لینک پرداخت بلیت

بعد از رزرو موفق، `paymentUrl` واقعی دریافت‌شده از سفیر ریل در `api/bookings.js` ثبت و در صورت فعال بودن تنظیمات کاربر، برای مقصد بله/ایتا ارسال می‌شود.

## متغیرهای محیطی

- `BALE_BOT_TOKEN`: توکن ربات بله. مسیر پیش‌فرض API: `https://tapi.bale.ai/bot<TOKEN>/<METHOD>`.
- `EITAA_BOT_TOKEN`: توکن ایتایار. مسیر پیش‌فرض API: `https://eitaayar.ir/api/<TOKEN>/<METHOD>`.
- `BALE_API_BASE_URL` و `EITAA_API_BASE_URL` برای تغییر endpoint در صورت نیاز.

توکن‌ها هرگز در Frontend یا `settings.html` ذخیره نمی‌شوند. کاربر فقط مقصد (`chat_id`) خود را در تنظیمات حسابش مشخص می‌کند.

## رویداد

`saveBooking` پس از ایجاد رکورد رزرو، در صورت وجود `paymentUrl`، `sendPaymentLinkToUser()` را فراخوانی می‌کند. خطای پیام‌رسان نباید رزرو را شکست دهد و در `payment_notification` ثبت می‌شود.
