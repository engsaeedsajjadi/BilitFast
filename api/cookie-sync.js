// api/cookie-sync.js — همگام‌سازی کوکی صفیر ریل با «یک کلیک» از طریق افزونه مرورگر.
//
// برای جلوگیری از نشت کوکی بین کاربران/تب‌ها، هر نشستِ دریافت یک «توکن جفت‌شدن» کوتاه‌عمر
// روی دامنه خود برنامه می‌سازد. صفحه login و افزونه هر دو همان cookie را به این endpoint
// می‌فرستند؛ بنابراین push/poll فقط داخل همان مرورگر/نشست به هم می‌رسند.
//
// اکشن‌ها:
//   push  → افزونه کوکی‌ها را می‌فرستد (ذخیره با برچسب زمانی)
//   poll  → برنامه آخرین همگام‌سازی همان نشست را دریافت می‌کند
//   clear → پاک‌کردن رکوردهای معلق همان نشست

const db = require('../lib/db');
const { guardApi } = require('../lib/guard');
const { readJsonBody, getRequestCookies, sha256Base64Url } = require('../lib/http');

const TTL_MS = 5 * 60 * 1000;
const MAX_RECORDS = 20;
const PAIR_COOKIE = 'bf_cookie_sync_pair';
const PAIR_RE = /^[A-Za-z0-9_-]{24,200}$/;

function getPairToken(req, body) {
  const headers = (req && req.headers) || {};
  const token = String(
    getRequestCookies(req)[PAIR_COOKIE] ||
    headers['x-bilitfast-pair'] || headers['X-BilitFast-Pair'] ||
    (body && body.pairToken) || ''
  ).trim();
  return PAIR_RE.test(token) ? token : '';
}

function getPairHash(req, body) {
  const token = getPairToken(req, body);
  return token ? sha256Base64Url('cookie-sync:' + token) : '';
}

function cleanupAll() {
  const now = Date.now();
  const all = db.find('cookie_sync', () => true).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  for (const rec of all) {
    const expired = (now - (rec.created_at || 0)) > TTL_MS;
    if (expired) db.remove('cookie_sync', rec.id);
  }
  const kept = db.find('cookie_sync', () => true).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  for (const old of kept.slice(MAX_RECORDS)) db.remove('cookie_sync', old.id);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'cookie-sync', limit: 120, windowMs: 60000 })) return;

  const body = readJsonBody(req);
  const action = body.action || 'poll';
  const pair_hash = getPairHash(req, body);

  try {
    cleanupAll();

    if (action === 'push') {
      if (!pair_hash) {
        return res.status(400).json({ ok: false, error: 'نشست همگام‌سازی یافت نشد. ابتدا در صفحه ورود روی «دریافت کوکی از افزونه» بزنید.' });
      }
      const cookies = Array.isArray(body.cookies)
        ? body.cookies.map((c) => String(c).slice(0, 2000)).filter((c) => /^[^=;\s]+=[^;]*$/.test(c)).slice(0, 30)
        : [];
      if (!cookies.length) {
        return res.status(400).json({ ok: false, error: 'کوکی‌ای ارسال نشده است.' });
      }
      const hasSession = cookies.some((c) => /^PHPSESSID=/i.test(c));
      db.insert('cookie_sync', {
        pair_hash,
        cookies,
        consumed: false,
        source: String(body.source || 'extension').slice(0, 40),
        has_session: hasSession,
      });
      cleanupAll();
      return res.status(200).json({ ok: true, count: cookies.length, has_session: hasSession });
    }

    if (action === 'poll') {
      if (!pair_hash) {
        return res.status(400).json({ ok: false, waiting: false, error: 'نشست همگام‌سازی معتبر نیست. دوباره روی دکمه دریافت کوکی از افزونه بزنید.' });
      }
      const now = Date.now();
      const candidates = db
        .find('cookie_sync', (s) => s.pair_hash === pair_hash && !s.consumed && (now - (s.created_at || 0)) <= TTL_MS)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      if (!candidates.length) {
        return res.status(200).json({ ok: false, waiting: true });
      }
      const rec = candidates[0];
      db.remove('cookie_sync', rec.id);
      return res.status(200).json({
        ok: true,
        cookies: rec.cookies,
        count: rec.cookies.length,
        has_session: !!rec.has_session,
        received_at: rec.created_at,
      });
    }

    if (action === 'clear') {
      if (!pair_hash) return res.status(200).json({ ok: true, cleared: 0 });
      const all = db.find('cookie_sync', (s) => s.pair_hash === pair_hash);
      for (const rec of all) db.remove('cookie_sync', rec.id);
      return res.status(200).json({ ok: true, cleared: all.length });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
