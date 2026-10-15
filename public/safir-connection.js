/* BilitFast: the only supported customer-facing SafirRail connection flow.
 * Extension -> one-time pairing -> local backend -> live verification -> save.
 * Never mark a guest/unverified cookie as connected. No manual cookie UI. */
(function () {
  'use strict';
  const byId = id => document.getElementById(id);
  const btn = byId('btn-ext-sync');
  const state = byId('conn-state');
  const result = byId('connect-result');
  const panel = byId('pair-panel');
  const timer = byId('pair-timer');
  const codeEl = byId('pair-code');
  const copyBtn = byId('copy-pair-code');
  let running = null;
  let sequence = 0;

  function show(text, mode = 'idle') {
    state.textContent = text;
    state.dataset.state = mode;
    result.hidden = mode !== 'error';
    if (mode === 'error') result.textContent = text;
  }
  function end() {
    if (running) clearInterval(running);
    running = null;
    panel.hidden = true;
    btn.disabled = false;
  }
  async function verifyStored() {
    const atStart = sequence;
    const cookies = BilitFast.getCookies();
    if (!BilitFast.hasSessionCookie(cookies)) {
      show('هنوز به سفیر ریل متصل نیستید.');
      return;
    }
    show('در حال بررسی نشست قبلی…', 'working');
    try {
      const v = await BilitFast.authFetch('/api/cookie-sync', { action: 'verify', cookies,
        verificationCookies: BilitFast.getVerificationCookies ? BilitFast.getVerificationCookies() : [] });
      if (atStart !== sequence) return;
      if (v && v.ok && v.valid && v.bookingVerified) show('✅ نشست سامانه رزرو تأیید شد.', 'ok');
      else if (v && v.ok && v.valid) show('✓ نشست در همین پنجره ذخیره شده و ورود عمومی تأیید شد. دسترسی رزرو هنوز تأیید نشده است؛ برای قطعیت، نتیجه درخواست واقعی رزرو ملاک خواهد بود.', 'partial');
      else if (v && v.reason === 'not_logged_in') {
        // A read-only booking landing page can ask for authentication without
        // proving that browser cookies are actually expired. Preserve them.
        show('کوکی نشست در همین تب موجود است، اما سامانه رزرو هنوز ورود را تأیید نکرده است. برای بررسی عملی رزرو به مسیر بازگردید.', 'partial');
      } else if (v && v.reason === 'no_session_cookie') {
        BilitFast.clearCookies();
        show('کوکی نشست یافت نشد؛ دوباره با افزونه متصل شوید.');
      } else {
        show('کوکی نشست در همین تب موجود است؛ تأیید آنلاین هنوز قطعی نیست. فقط درخواست واقعی رزرو وضعیت دسترسی را تعیین می‌کند.', 'partial');
      }
    } catch (_) {
      if (atStart === sequence) show('کوکی نشست در همین تب موجود است؛ بررسی آنلاین به‌دلیل خطای شبکه انجام نشد.', 'partial');
    }
  }

  async function start() {
    end();
    const ticket = ++sequence;
    btn.disabled = true;
    show('در حال ساخت کد اتصال…', 'working');
    let pair;
    try { pair = await BilitFast.authFetch('/api/cookie-sync', { action: 'pair' }); }
    catch (_) { pair = null; }
    if (ticket !== sequence) return;
    if (!pair || !pair.ok || !/^\d{6}$/.test(String(pair.code)) || !pair.nonce) {
      show((pair && pair.error) || 'امکان ساخت کد نیست. اتصال به سرور وب آژانس و ورود به حساب را بررسی کنید.', 'error');
      end();
      return;
    }
    codeEl.textContent = pair.code;
    copyBtn.textContent = '📋 کپی کد';
    panel.hidden = false;
    const until = Date.now() + Math.min(120000, pair.expiresInMs || 120000);
    show('کد را در افزونه مرورگر وارد کنید؛ منتظر پاسخ هستیم…', 'working');
    let polling = false;
    async function poll() {
      if (ticket !== sequence || polling) return;
      if (Date.now() >= until) {
        show('مهلت کد تمام شد. برای دریافت کد جدید همین دکمه را بزنید.', 'error');
        end();
        return;
      }
      timer.textContent = 'زمان باقی‌مانده: ' + Math.ceil((until - Date.now()) / 1000) + ' ثانیه';
      polling = true;
      try {
        const data = await BilitFast.authFetch('/api/cookie-sync', { action: 'poll', nonce: pair.nonce });
        if (ticket !== sequence) return;
        if (data && data.ok && Array.isArray(data.cookies) && data.cookies.length) {
          // Verify with the real service BEFORE persisting the imported session.
          show('کوکی منتقل شد؛ در حال تأیید ورود واقعی در سفیر ریل…', 'working');
          clearInterval(running); running = null;
          let v;
          try { v = await BilitFast.authFetch('/api/cookie-sync', { action: 'verify', cookies: data.cookies, verificationCookies: data.verificationCookies || [] }); }
          catch (_) { v = null; }
          if (ticket !== sequence) return;
          // Transport and authentication are distinct. An explicit one-time
          // handoff with a PHPSESSID must not disappear merely because a
          // read-only verification endpoint is inconclusive or network-bound.
          // Keep it ONLY in this tab's sessionStorage and mark it provisional.
          // Actual reservation permission remains decided by the official
          // reservation request; we never report it as verified here.
          if (!BilitFast.hasSessionCookie(data.cookies)) {
            show('افزونه اطلاعاتی فرستاد، اما کوکی نشست رزرو داخل آن نبود؛ از حساب رزرو وارد شوید.', 'error');
            end();
            return;
          }
          BilitFast.setCookies(data.cookies, data.verificationCookies || []);
          if (!BilitFast.hasSessionCookie(BilitFast.getCookies())) {
            show('کوکی به سرور رسید اما در این تب ذخیره نشد. ذخیره‌سازی مرورگر را بررسی و همین صفحه را دوباره بارگذاری کنید.', 'error');
            end();
            return;
          }
          const returning = new URLSearchParams(window.location.search).get('return');
          const safeReturn = returning && /^route\.html\?id=[1-9][0-9]*$/.test(returning);
          if (v && v.ok && v.valid && v.bookingVerified) {
            show('✅ نشست به این تب منتقل و ورود سامانه رزرو تأیید شد.', 'ok');
            if (safeReturn) window.location.assign(returning);
          } else if (v && v.ok && v.valid) {
            show('✓ نشست به این تب منتقل و ورود عمومی تأیید شد؛ تأیید بخش رزرو هنگام شروع عملیات واقعی انجام می‌شود.' +
              (safeReturn ? ' برای بازگشت به مسیر از دکمه زیر استفاده کنید.' : ''), 'partial');
          } else {
            const reason = v && v.reason;
            const explanation = reason === 'not_logged_in' || reason === 'reservation_login_required'
              ? 'سایت فعلاً ورود رزرو را تأیید نکرده است.'
              : reason === 'network' || reason === 'verification_unavailable' || !v
                ? 'بررسی آنلاین به‌دلیل مشکل ارتباطی انجام نشد.'
                : 'پاسخ سامانه برای تأیید ورود کافی نیست.';
            show('✓ کوکی نشست از افزونه دریافت و در همین تب ذخیره شد؛ ' + explanation +
              ' انتقال انجام شده ولی مجوز رزرو هنوز تأیید نشده است.' +
              (safeReturn ? ' برای بازگشت به مسیر از دکمه زیر استفاده کنید.' : ''), 'partial');
          }
          if (safeReturn) {
            const returnButton = byId('return-to-route');
            if (returnButton) {
              returnButton.hidden = false;
              returnButton.onclick = () => window.location.assign(returning);
            }
          }
          end();
          return;
        }
        if (data && data.expired) {
          show('کد منقضی یا باطل شده است؛ کد تازه بگیرید.', 'error');
          end();
        } else if (data && data.error) {
          show(data.error, 'error');
          end();
        }
      } catch (_) {
        // A temporary local-network failure is retried until the PIN expires.
      } finally { polling = false; }
    }
    running = setInterval(poll, 2000);
    await poll();
  }
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(codeEl.textContent); copyBtn.textContent = 'کپی شد ✓'; }
    catch (_) { copyBtn.textContent = 'کد را از بالا انتخاب و کپی کنید'; }
  });
  btn.addEventListener('click', start);
  window.addEventListener('pagehide', () => { sequence++; end(); });
  verifyStored();
})();
