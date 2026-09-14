# BilitFast — ایمیج تولید
#
# نکته مهم درباره شبکه: صفیر ریل درخواست‌های آی‌پی دیتاسنتر/خارج از ایران را
# مسدود می‌کند. این ایمیج فقط روی میزبانی معنا دارد که از داخل ایران به
# safirrail.ir دسترسی شبکه‌ای دارد. روی ابرهای خارجی، جستجو با fetch failed
# شکست می‌خورد — مشکل از کد نیست.

# ---------- مرحله ۱: نصب وابستگی‌ها ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# فقط فایل‌های وابستگی کپی می‌شوند تا لایه کش با هر تغییر کد باطل نشود.
COPY package.json package-lock.json* ./

# npm ci برای build تکرارپذیر؛ اگر lock نبود به install برمی‌گردیم.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ---------- مرحله ۲: ایمیج نهایی ----------
FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    BILITFAST_ENFORCE_SECURITY=1 \
    BILITFAST_MULTIUSER=1 \
    BILITFAST_DATA_DIR=/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# داده باید روی volume باشد، نه داخل لایه ایمیج — وگرنه با هر deploy پاک می‌شود.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

# اجرا با کاربر غیر root: اگر کدی آسیب ببیند، دسترسی ریشه نداشته باشد.
USER node

EXPOSE 3000

# tini به‌عنوان PID 1 تا SIGTERM واقعاً به Node برسد و خاموشی تمیز کار کند.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
