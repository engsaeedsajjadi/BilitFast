// api/cookie-sync.js — همگام‌سازی کوکی صفیر ریل از افزونه مرورگر، به‌صورت امن.
//
// چرا افزونه؟ کوکی نشست (PHPSESSID) از نوع HttpOnly است؛ فقط افزونه (با مجوز
// cookies) می‌تواند آن را بخواند.
//
// ⚠️ مدل امنیتی (بازنویسی‌شده):
// نسخه پیشین اکشن‌های push/poll را بدون احراز هویت می‌پذیرفت. یعنی روی یک
// دامنه عمومی، هر کسی می‌توانست poll بزند و آخرین PHPSESSID را بردارد (ربودن
// نشست) یا با push کوکی خودش را جای کوکی قربانی بنشاند.
//
// حالا جریان بر پایه «کد جفت‌سازی یک‌بارمصرف» است:
//   ۱) برنامه (کاربرِ واردشده، یا کلاینت محلی) اکشن `pair` را صدا می‌زند و یک
//      کد کوتاه یک‌بارمصرف با عمر ۲ دقیقه می‌گیرد.
//   ۲) کاربر همان کد را در افزونه وارد می‌کند؛ افزونه با `push` + همان کد
//      کوکی‌ها را می‌فرستد. بدون کد معتبر، push رد می‌شود.
//   ۳) فقط همان کلاینتی که کد را ساخته (با nonce مخفی که هرگز منتشر نمی‌شود)
//      می‌تواند با `poll` کوکی را تحویل بگیرد.
//   ۴) رکورد بلافاصله پس از یک بار تحویل حذف می‌شود (یک‌بارمصرف واقعی) و در
//      هر حال پس از ۵ دقیقه منقضی می‌گردد.
//
// افزون بر آن: وقتی برنامه روی شبکه عمومی سرو می‌شود (نه localhost)، این
// endpoint فقط برای کاربرِ واردشده به حساب فعال است.

const crypto = require('crypto');
const db = require('../lib/db');
const { guardApi, getClientIp } = require('../lib/guard');
const { getSessionUser } = require('../lib/auth');

const PAIR_TTL_MS = 2 * 60 * 1000;   // اعتبار کد جفت‌سازی: ۲ دقیقه
const COOKIE_TTL_MS = 5 * 60 * 1000; // اعتبار کوکی تحویل‌نشده: ۵ دقیقه
const MAX_RECORDS = 20;

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

/** آیا درخواست از خود همان دستگاه (اجرای محلی) می‌آید؟ */
function isLocalRequest(req) {
  const ip = String(getClientIp(req) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

/** هش کردن nonce تا مقدار خام هرگز در پایگاه‌داده ننشیند. */
function hashNonce(n) {
  return crypto.createHash('sha256').update(String(n)).digest('hex');
}

/** پاک‌سازی رکوردهای منقضی. */
function sweep() {
  const now = Date.now();
  for (const r of db.find('cookie_sync', () => true)) {
    const age = now - (r.created_at || 0);
    const ttl = r.cookies ? COOKIE_TTL_MS : PAIR_TTL_MS;
    if (age > ttl || r.consumed) db.remove('cookie_sync', r.id);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'cookie-sync', limit: 60, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = body.action || 'poll';
  const user = getSessionUser(req, body);
  const local = isLocalRequest(req);

  /* کنترل دسترسی، به تفکیک اکشن.
   *
   * باگی که رفع شد: قبلاً هر سه اکشن روی استقرار عمومی نیازمند ورود به حساب
   * بودند. ولی افزونه مرورگر ذاتاً نمی‌تواند نشست حساب را داشته باشد — در
   * زمینهٔ خودش اجرا می‌شود و کوکی نشستِ برنامه را ندارد. پس روی دامنهٔ
   * آنلاین، push همیشه ۴۰۱ می‌گرفت و زنجیرهٔ انتقال کوکی همان‌جا قطع می‌شد.
   *
   * نکتهٔ امنیتی: push به احراز هویتِ حساب نیاز ندارد، چون کد ۶ رقمیِ
   * یک‌بارمصرف با عمر ۲ دقیقه خودش مجوز است — و آن کد را فقط کسی دارد که
   * لحظاتی پیش در برنامه (به‌عنوان کاربرِ واردشده) اکشن pair را زده. بدون
   * کد معتبر، push رد می‌شود. مهاجم هم چیزی به دست نمی‌آورد: تحویل کوکی
   * فقط با poll انجام می‌شود که همچنان nonce مخفی و تطابق مالکیت می‌خواهد.
   *
   * پس دروازه فقط روی pair و poll می‌ماند — دو اکشنی که واقعاً از سمت
   * برنامه صدا زده می‌شوند و نشست حساب دارند.
   */
  if (!local && !user && action !== 'push') {
    res.status(401).json({
      ok: false,
      loginRequired: true,
      error: 'برای همگام‌سازی کوکی روی دسترسی اینترنتی، ابتدا وارد حساب کاربری برنامه شوید.',
    });
    return;
  }

  const owner = user ? 'u:' + user.id : 'local';

  try {
    sweep();

    /* ۱) ساخت کد جفت‌سازی یک‌بارمصرف (از سمت برنامه) */
    if (action === 'pair') {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const nonce = crypto.randomBytes(24).toString('base64url');
      db.insert('cookie_sync', {
        kind: 'pair',
        code,
        nonce_hash: hashNonce(nonce),
        owner,
        consumed: false,
        cookies: null,
      });
      const all = db.find('cookie_sync', () => true)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      for (const old of all.slice(MAX_RECORDS)) db.remove('cookie_sync', old.id);
      // nonce فقط همین یک بار به سازنده داده می‌شود و در سرور فقط هشِ آن می‌ماند.
      res.status(200).json({ ok: true, code, nonce, expiresInMs: PAIR_TTL_MS });
      return;
    }

    /* ۲) ارسال کوکی از افزونه — نیازمند کد جفت‌سازی معتبر */
    if (action === 'push') {
      const code = String(body.code || '').trim();
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json({
          ok: false,
          error: 'کد جفت‌سازی لازم است. در برنامه دکمه «دریافت کوکی از افزونه» را بزنید تا کد ۶ رقمی نمایش داده شود.',
        });
        return;
      }
      const now = Date.now();
      const rec = db.find('cookie_sync', (s) => s.kind === 'pair' && s.code === code &&
        !s.consumed && !s.cookies && (now - (s.created_at || 0)) <= PAIR_TTL_MS)[0];
      if (!rec) {
        res.status(400).json({ ok: false, error: 'کد جفت‌سازی نامعتبر یا منقضی شده است.' });
        return;
      }

      const cookies = Array.isArray(body.cookies)
        ? body.cookies.map((c) => String(c).slice(0, 2000)).filter(Boolean).slice(0, 30)
        : [];
      if (!cookies.length) {
        res.status(400).json({ ok: false, error: 'کوکی‌ای ارسال نشده است.' });
        return;
      }
      const hasSession = cookies.some((c) => /^PHPSESSID=/i.test(c));
      db.update('cookie_sync', rec.id, {
        cookies,
        has_session: hasSession,
        source: String(body.source || 'extension').slice(0, 40),
        filled_at: Date.now(),
      });
      res.status(200).json({ ok: true, count: cookies.length, has_session: hasSession });
      return;
    }

    /* ۳) تحویل کوکی — فقط سازنده همان کد، با nonce مخفی */
    if (action === 'poll') {
      const nonce = String(body.nonce || '');
      if (!nonce) {
        res.status(400).json({ ok: false, error: 'nonce لازم است (ابتدا اکشن pair را صدا بزنید).' });
        return;
      }
      const nh = hashNonce(nonce);
      const now = Date.now();
      const rec = db.find('cookie_sync', (s) => s.nonce_hash === nh && !s.consumed &&
        (now - (s.created_at || 0)) <= COOKIE_TTL_MS)[0];
      if (!rec) {
        res.status(200).json({ ok: false, waiting: false, expired: true });
        return;
      }
      // مالکیت: رکورد باید متعلق به همان کاربر/کلاینت باشد
      if (rec.owner !== owner) {
        res.status(403).json({ ok: false, error: 'این رکورد متعلق به نشست دیگری است.' });
        return;
      }
      if (!rec.cookies) {
        res.status(200).json({ ok: false, waiting: true });
        return;
      }
      const out = {
        ok: true,
        cookies: rec.cookies,
        count: rec.cookies.length,
        has_session: !!rec.has_session,
        received_at: rec.filled_at || rec.created_at,
      };
      // یک‌بارمصرف واقعی: بلافاصله حذف می‌شود
      db.remove('cookie_sync', rec.id);
      res.status(200).json(out);
      return;
    }

    res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
