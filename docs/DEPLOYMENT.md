# استقرار BilitFast — چندکاربره و ابری

## پیش از هر چیز: محدودیت شبکه

صفیر ریل درخواست‌های آی‌پی دیتاسنتر و خارج از ایران را در سطح شبکه مسدود
می‌کند. این محدودیت سمت آن‌هاست و با کد قابل دور زدن نیست.

> سرور را جایی بگذارید که از آنجا `safirrail.ir` واقعاً در دسترس باشد
> (معمولاً یک VPS ایرانی). روی ابرهای خارجی، جستجو با `fetch failed`
> شکست می‌خورد.

آزمون سریع روی سرور مقصد پیش از استقرار:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://safirrail.ir/
```

اگر `000` برگشت، آن سرور به درد نمی‌خورد.

---

## ۱. اجرای مستقیم (VPS)

```bash
git clone <repo> && cd BilitFast
npm ci --omit=dev
cp .env.example .env
```

کلیدها را بسازید و در `.env` بگذارید:

```bash
node -e "console.log('BILITFAST_SESSION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('BILITFAST_LICENSE_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('BILITFAST_TOKEN_KEY='   + require('crypto').randomBytes(32).toString('hex'))"
```

سپس:

```bash
npm run start:prod        # معادل NODE_ENV=production node server.js
```

`server.js` پیش از بالا آمدن بررسی می‌کند که کلیدها تنظیم و ذخیره‌ساز پایدار
باشد. اگر نباشد **بالا نمی‌آید** — این عمدی است، چون سرویسِ بالاآمده با کلید
موقتی یعنی نشست‌هایی که با هر ری‌استارت باطل می‌شوند.

### سرویس systemd

```ini
[Unit]
Description=BilitFast
After=network.target

[Service]
Type=simple
User=bilitfast
WorkingDirectory=/opt/bilitfast
EnvironmentFile=/opt/bilitfast/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

---

## ۲. اجرا با Docker

```bash
docker build -t bilitfast .

docker run -d --name bilitfast \
  -p 3000:3000 \
  -v bilitfast-data:/data \
  --env-file .env \
  --restart unless-stopped \
  bilitfast
```

نکات مهم:

- **volume الزامی است.** بدون `-v`، پوشه `/data` داخل لایه کانتینر می‌ماند و
  با هر `docker run` تازه، همه کاربران و رزروها پاک می‌شوند.
- `.env` هرگز داخل ایمیج نمی‌رود (`.dockerignore`). با `--env-file` یا
  `-e` تزریق کنید.
- کانتینر با کاربر غیر root اجرا می‌شود.
- `tini` به‌عنوان PID 1 هست تا `docker stop` واقعاً خاموشی تمیز بدهد.

### پشت Nginx با HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name bilitfast.example.ir;

    ssl_certificate     /etc/letsencrypt/live/bilitfast.example.ir/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bilitfast.example.ir/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

> `X-Forwarded-For` را حتماً بگذارید. محدودسازی نرخ به آی‌پی واقعی نیاز دارد
> و بدون آن همه کاربران یک آی‌پی (`127.0.0.1`) دیده می‌شوند. کد فقط وقتی به
> این هدر اعتماد می‌کند که اتصال از شبکه محلی/خصوصی آمده باشد — یعنی همین
> reverse proxy — پس کلاینت بیرونی نمی‌تواند جعلش کند.

---

## ۳. نخستین مدیر (bootstrap)

روی نصب تازه هیچ کاربری وجود ندارد. یک بار:

```bash
curl -X POST https://your-domain/api/admin-users \
  -H 'Content-Type: application/json' \
  -d '{"action":"bootstrap","username":"admin","password":"یک-گذرواژه-قوی","display_name":"مدیر"}'
```

یا کافی است در مرورگر به `/admin.html` بروید؛ اگر مدیری نباشد، فرم ساخت را
نشان می‌دهد.

**به محض ساخته شدن نخستین مدیر، این مسیر برای همیشه بسته می‌شود** و دفعات
بعد `403` می‌دهد.

---

## ۴. ساخت کاربر تستی

از `/admin.html` یا مستقیم:

```bash
curl -X POST https://your-domain/api/admin-users \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>' \
  -d '{
        "action": "create",
        "username": "test01",
        "role": "tester",
        "expires_at": "2026-10-01",
        "max_searches": 100,
        "max_reservations": 10
      }'
```

اگر `password` ندهید، یکی امن تولید و **فقط همان یک‌بار** برگردانده می‌شود.

قواعد دسترسی:

| وضعیت | نتیجه |
|---|---|
| `is_active = false` | ورود و همه APIهای محافظت‌شده → `403` |
| `expires_at` گذشته | ورود و همه APIهای محافظت‌شده → `403` |
| سهمیه جستجو تمام | `/api/search` → `429` با `quotaExceeded` |
| سهمیه رزرو تمام | `/api/reserve` (گام start) → `429` |

سهمیه رزرو فقط در گام `start` مصرف می‌شود، نه در `submit` — تا تلاش دوباره
روی کپچا، سهمیه کاربر را نخورد.

---

## ۵. متغیرهای محیطی

| متغیر | الزامی | نقش |
|---|---|---|
| `BILITFAST_SESSION_KEY` | بله (تولید) | امضای توکن نشست |
| `BILITFAST_LICENSE_KEY` | بله (تولید) | امضای مجوز و دوره آزمایشی |
| `BILITFAST_TOKEN_KEY` | بله (تولید) | رمزگذاری توکن رزرو و اعتبارنامه صفیر |
| `BILITFAST_MULTIUSER` | خیر | `1` = ورود اجباری. روی سرور حتماً `1` |
| `BILITFAST_DATA_DIR` | خیر | مسیر داده (در Docker: `/data`) |
| `BILITFAST_CRON_SECRET` | خیر | راز `/api/cron`؛ بدون آن زمان‌بند `503` |
| `BILITFAST_ALLOWED_ORIGINS` | خیر | مبدأهای CORS با کاما. خالی = فقط same-origin |
| `PORT` | خیر | پیش‌فرض `3000` |

`server.js` به‌طور خودکار `NODE_ENV=production`،
`BILITFAST_ENFORCE_SECURITY=1` و `BILITFAST_MULTIUSER=1` را تنظیم می‌کند.

> **هشدار:** اگر کلیدها را عوض کنید، همه نشست‌های باز و اعتبارنامه‌های
> رمزشده صفیر ریل باطل می‌شوند و کاربران باید دوباره وارد شوند.

---

## ۶. اتصال نسخه دسکتاپ به سرور ابری

به‌صورت پیش‌فرض، نسخه دسکتاپ سرور را داخل خودش بالا می‌آورد. برای وصل شدن به
بک‌اند راه دور:

```bash
API_BASE_URL=https://bilitfast.example.ir
```

یا در `settings.json` داخل پوشه داده برنامه:

```json
{ "api_base_url": "https://bilitfast.example.ir" }
```

در این حالت سرور محلی اصلاً اجرا نمی‌شود.

**فقط `https` پذیرفته می‌شود** (به‌جز `localhost` برای تست). توکن نشست روی این
اتصال رد و بدل می‌شود؛ روی `http` هر کسی در مسیر می‌تواند آن را بردارد و جای
کاربر جا بزند. مقدار `http` نادیده گرفته و در کنسول گزارش می‌شود.

روی سرور هم `BILITFAST_ALLOWED_ORIGINS` را تنظیم کنید. هرگز `*` نگذارید:
این API با توکن Bearer کار می‌کند و مبدأ باز یعنی هر سایتی می‌تواند از طرف
کاربر درخواست بزند.

---

## ۷. پشتیبان‌گیری

همه چیز در یک فایل است:

```bash
docker cp bilitfast:/data/db.json ./backup-$(date +%F).json
# یا در اجرای مستقیم:
cp data/db.json ./backup-$(date +%F).json
```

این فایل شامل هش گذرواژه‌ها و اعتبارنامه‌های **رمزشده** صفیر ریل است. اگر
کلیدها را گم کنید، اعتبارنامه‌ها غیرقابل بازیابی می‌شوند — پس کلیدها را جدا
از پشتیبان نگه دارید.

برای چند نمونه هم‌زمان، `db.json` کافی نیست؛ `KV_REST_API_URL` را تنظیم کنید
تا `lib/db-remote.js` فعال شود.

---

## ۸. سلامت سرویس

```bash
curl https://your-domain/api/health
```

Dockerfile خودش `HEALTHCHECK` روی همین مسیر دارد.
