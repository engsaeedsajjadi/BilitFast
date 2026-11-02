'use strict';
// Customer-only first boot. Generates durable local secrets on the target host.
// This module is deliberately independent of npm packages for portable use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function initialize(root, logger = console.log) {
  const publicPath = path.join(root, 'config', 'license-public.pem');
  if (!fs.existsSync(publicPath)) throw new Error('کلید عمومی فروشنده موجود نیست: config/license-public.pem. بسته را از فروشنده معتبر دریافت کنید.');
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicPath));
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('کلید عمومی لایسنس معتبر نیست.');
  const dataDir = path.join(root, 'data');
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    logger('پیکربندی قبلی حفظ شد؛ کلیدهای امنیتی و داده‌ها بازنشانی نشدند.');
    return { firstRun: false, envPath, dataDir };
  }
  // Refuse to mint fresh secrets if data already exists: it would destroy access
  // to prior encrypted records and could silently restart a trial.
  if (fs.existsSync(path.join(dataDir,'installation.json')) || fs.existsSync(path.join(dataDir,'db.json'))) {
    throw new Error('داده نصب قبلی وجود دارد اما .env گم شده است. فایل .env اصلی را از نسخه پشتیبان بازیابی کنید؛ نصب را ریست نکنید.');
  }
  const hex = () => crypto.randomBytes(32).toString('hex');
  const master = hex(), bootstrap = hex();
  const content = [
    'NODE_ENV=production',
    'PORT=3000',
    'BILITFAST_DOMAIN=localhost',
    'BILITFAST_SELF_HOSTED=1',
    'BILITFAST_MASTER_KEY='+master,
    'BILITFAST_ADMIN_BOOTSTRAP_SECRET='+bootstrap,
    'BILITFAST_MULTIUSER=1',
    'BILITFAST_SINGLE_USER=1',
    'BILITFAST_ENFORCE_SECURITY=1',
    'BILITFAST_ENFORCE_LICENSE=1',
    'BILITFAST_BIND_HOST=127.0.0.1',
    'BILITFAST_ALLOWED_ORIGINS=',
  ].join('\n')+'\n';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(envPath, content, { flag:'wx', mode:0o600 });
  logger('نصب جدید: پیکربندی اختصاصی همین کامپیوتر ایجاد شد.');
  logger('رمز راه اندازی حساب مالک (فقط یک بار نمایش داده می شود):');
  logger(bootstrap);
  logger('این رمز را در صفحه admin.html استفاده کنید. رمز را برای شخص دیگری نفرستید.');
  logger('فایل .env و پوشه data را با هم، به صورت محرمانه پشتیبان بگیرید.');
  return { firstRun:true, envPath, dataDir };
}
module.exports = { initialize };
if (require.main === module) {
  try { initialize(path.resolve(__dirname,'..')); } catch(e) { console.error('ERROR:',e.message); process.exitCode=1; }
}
