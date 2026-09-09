// api/health.js — بررسی سلامت اتصال برنامه به سامانه صفیر ریل.
// اکشن‌ها:
//   check → (بدنه: cookies) بررسی می‌کند سرور به صفیر ریل می‌رسد یا نه
//           (مثلاً روی Vercel به‌خاطر بلاک IP دیتاسنتر، نه) و کوکی نشست فرستاده می‌شود؟
const { guardApi } = require('../lib/guard');
const core = require('../lib/core');
const { config } = core;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'health', limit: 30, windowMs: 60000 })) return;

  const body = (typeof req.body === 'string') ? safeParse(req.body) : (req.body || {});
  const cookies = Array.isArray(body.cookies) ? body.cookies : [];

  // گزارش وضعیت ذخیره‌سازی/پایش (برای صفحه حریم خصوصی و بررسی استقرار)
  if (body.action === 'storage') {
    const db = require('../lib/db');
    const monitor = require('../lib/monitor');
    res.status(200).json({
      ok: true,
      storage: db.storageStatus(),
      monitor: monitor.capability(),
    });
    return;
  }

  // ۱) دسترسی شبکه به سامانه
  let network = { reachable: false, ms: null, status: null };
  const started = Date.now();
  try {
    const { safirFetch } = require('../lib/http');
    const resp = await safirFetch(config.base_url + (config.login_form_url || '/fa/UserAut.php'), {
      method: 'GET',
      headers: core.buildHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    network = { reachable: true, ms: Date.now() - started, status: resp.status };
  } catch (e) {
    network = { reachable: false, ms: Date.now() - started, status: null, error: (e && e.message) || String(e) };
  }

  const hasSession = core.hasSessionCookie(cookies);
  let data = {
    ok: true,
    network,
    session_cookie: hasSession,
    base_url: config.base_url,
    server_datacenter_ip_blocked: !network.reachable && core.isCloudEnv(),
    message: !network.reachable
      ? 'دسترسی به سامانه صفیر ریل برقرار نشد. ' + core.networkHint()
      : (hasSession
        ? 'اتصال برقرار است و کوکی نشست ارسال می‌شود.'
        : 'اتصال برقرار است اما کوکی نشست (PHPSESSID) فرستاده نشده؛ در صفحه «ورود صفیر ریل» کوکی بگیرید.'),
  };
  res.status(200).json(data);
};

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
}
