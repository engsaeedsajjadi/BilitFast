// api/monitor.js — کنترل پایشگر سمت سرور (بدون نیاز به بازماندن مرورگر).
// اکشن‌ها (نیازمند ورود):
//   start → شروع پایش یک مسیر   (body: fields, passengers, prefs, intervalMs)
//   stop  → توقف یک پایشگر      (body: monitor_id)
//   stop-all
//   list  → فهرست پایشگرهای کاربر
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const monitor = require('../lib/monitor');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'monitor', limit: 60, windowMs: 60000 })) return;

  const body = readBody(req);
  const user = getSessionUser(req, body);
  if (!user) {
    return res.status(200).json({ ok: false, loggedIn: false, error: 'ابتدا وارد حساب خود شوید.' });
  }

  const action = body.action || 'list';

  try {
    // گزارش صادقانه قابلیت: روی سرورلس بدون Cron، پایش سمت سرور قابل اتکا نیست
    if (action === 'capability') {
      return res.status(200).json({ ok: true, ...monitor.capability() });
    }
    if (action === 'start') {
      const cap = monitor.capability();
      if (!cap.supported) {
        return res.status(503).json({
          ok: false, unsupported: true, error: cap.reason, capability: cap,
        });
      }
      const r = monitor.startMonitor(user, {
        fields: body.fields,
        passengers: body.passengers,
        prefs: body.prefs,
        intervalMs: body.intervalMs || body.interval_ms,
      });
      return res.status(r.ok ? 200 : 400).json({ ...r, capability: monitor.capability() });
    }
    if (action === 'stop') {
      const r = monitor.stopMonitor(user, body.monitor_id);
      return res.status(r.ok ? 200 : 400).json(r);
    }
    if (action === 'stop-all') {
      const r = monitor.stopAllForUser(user.id);
      return res.status(200).json(r);
    }
    // list (پیش‌فرض)
    const list = monitor.listUserMonitors(user.id).map((m) => ({
      id: m.id,
      fields: m.fields,
      active: !!m.active,
      interval_ms: m.interval_ms,
      tick_count: m.tick_count || 0,
      last_tick_at: m.last_tick_at || 0,
      last_ok_at: m.last_ok_at || 0,
      last_error: m.last_error || '',
      results: (m.results || []).slice(0, 5),
      created_at: m.created_at || 0,
    }));
    return res.status(200).json({ ok: true, monitors: list });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
};
