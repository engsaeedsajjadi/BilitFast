// -*- coding: utf-8 -*-
// e2e-captcha-loop.js — شبیه‌سازی کامل صفیر ریل با موک محلی و اجرای دقیقِ
// همان زنجیره درخواست‌هایی که مرورگر (route.html) انجام می‌دهد:
//   start → solve-captcha → submit → (کپچای اشتباه؟) → حل/ارسال دوباره
// هدف: تأیید مکانیک حلقه «تلاش تا پذیرش» و پیدا کردن نقاط شکست واقعی.
// اجرا: node scripts/e2e-captcha-loop.js

const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.BILITFAST_DATA_DIR = fs.mkdtempSync(require('os').tmpdir() + '/bf-e2e-');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples', 'real');
const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'labels.json'), 'utf8'));

/* ---------------- موک صفیر ریل ---------------- */
// کپچاها از نمونه‌های واقعی (با برچسب) سرو می‌شوند تا پاسخ‌دهی کپچا واقعی باشد.
const sampleFiles = Object.keys(LABELS).sort();
let captchaCounter = 0; // چند کپچا صادر شده
let currentCaptcha = null; // { id, file, text }
let wrongSubmits = 0;
let acceptedSubmits = 0;
const issuedCaptchas = [];
// برای شبیه‌سازی خطای OCR: N ارسال اول (حتی درست) رد می‌شوند؛ قابل تنظیم در تست
let forceWrongRemaining = 0;

function nextCaptcha() {
  const file = sampleFiles[captchaCounter % sampleFiles.length];
  captchaCounter++;
  currentCaptcha = {
    id: String(100000 + captchaCounter),
    file,
    text: String(LABELS[file] || ''),
  };
  issuedCaptchas.push(currentCaptcha);
  return currentCaptcha;
}

function captchaAjaxBody(cap) {
  const b64 = fs.readFileSync(path.join(SAMPLES_DIR, cap.file)).toString('base64');
  return cap.id + '@' + b64;
}

function shellPage() {
  // پوسته JS-رندر (مثل صفحه واقعی): بدون تصویر کپچا، با ارجاع به captchaAjax
  return `<html><head><title>رزرو</title>
<script>function captchaNew(){/* POST to captchaAjax.php */}</script>
</head><body>
<form name="mainFrm" action="TresV.php" method="post">
<input type="hidden" name="captchaId" value=""/>
<input type="hidden" name="ajaxResponse" value=""/>
<input type="hidden" name="srvc" value="123456"/>
کد امنیتی: <input type="text" name="Ksubmit" value=""/>
<input type="submit" name="btn" value="ادامه"/>
</form>
</body></html>`;
}

function passengerPage() {
  return `<html><body>
<form name="chkForm" action="VerifyTck.php" method="post">
<input type="hidden" name="totalprice" value="1234567"/>
نام: <input type="text" name="fn0" value=""/>
نام خانوادگی: <input type="text" name="ln0" value=""/>
کد ملی: <input type="text" name="pid0" value=""/>
روز: <input type="text" name="ruz0" value=""/>
ماه: <input type="text" name="mah0" value=""/>
سال: <input type="text" name="sal0" value=""/>
<input type="submit" name="btn" value="ثبت"/>
</form>
</body></html>`;
}

function paymentPage() {
  return `<html><body><div>در حال انتقال به درگاه پرداخت</div>
<script>document.location="https://pec.shaparak.ir/NewIPG/?Token=ABC123";</script>
</body></html>`;
}

function parseUrlEncoded(s) {
  const out = {};
  for (const pair of String(s || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Set-Cookie', 'PHPSESSID=mocksession; path=/');
        if (req.url.startsWith('/etrain/TresV-auth.php')) {
          nextCaptcha(); // صفحه اولیه کپچای نشست را می‌سازد
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(shellPage());
        } else if (req.url.startsWith('/etrain/captchaAjax.php')) {
          if (!currentCaptcha) nextCaptcha();
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(captchaAjaxBody(currentCaptcha));
        } else if (req.url.startsWith('/etrain/TresV.php')) {
          const f = parseUrlEncoded(body);
          const sent = String(f.Ksubmit || '').trim();
          let forcedWrong = false;
          if (forceWrongRemaining > 0) { forceWrongRemaining--; forcedWrong = true; }
          // اعتبارسنجی مثل سایت: کد باید با کپچای جاری نشست مطابقت داشته باشد
          if (!forcedWrong && sent && currentCaptcha && sent === currentCaptcha.text) {
            acceptedSubmits++;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(passengerPage());
          } else {
            wrongSubmits++;
            currentCaptcha = null; // کپچای اشتباه → نشست منتظر کپچای تازه
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(shellPage());
          }
        } else if (req.url.startsWith('/etrain/VerifyTck.php')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paymentPage());
        } else {
          res.writeHead(404); res.end('not found');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------- فراخوانی API واقعی مثل مرورگر ---------------- */
function makeReqRes(payload) {
  const req = {
    method: 'POST',
    query: {},
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify(payload),
  };
  let captured = null;
  const res = {
    status(code) { this._code = code; return this; },
    json(obj) { captured = obj; return this; },
  };
  return { req, res, get: () => captured };
}

(async () => {
  const server = await startMock();
  const port = server.address().port;
  const mockBase = 'http://127.0.0.1:' + port;

  // تغییر base_url قبل از بارگذاری ماژول‌ها (شیء تنظیمات مشترک است)
  const cfg = require(path.join(ROOT, 'config.json'));
  cfg.base_url = mockBase;

  const handler = require(path.join(ROOT, 'api', 'reserve.js'));

  async function call(payload) {
    const { req, res, get } = makeReqRes(payload);
    await handler(req, res);
    return get();
  }

  let failures = 0;
  const test = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
    if (!cond) failures++;
  };

  /* --- ۱) شروع رزرو → باید مرحله کپچا با تصویر بیاید --- */
  const start = await call({
    action: 'start',
    fields: { from_city: 'تهران', to_city: 'مشهد', date: '1404/07/10', train_number: '12345' },
    passengers: [{ first_name: 'الف', last_name: 'ب', national_code: '0012345679', birth_day: '1', birth_month: '1', birth_year: '1370', quota_type: 'عادی' }],
    train: { 'شماره قطار': '12345', 'ساعت حرکت': '10:00', 'قیمت': '1,234,567', 'نوع کوپه': '4تخته', 'شرکت': 'تست', 'ظرفیت': 5, srvc: '123456' },
    cookies: [],
  });
  test('start: ok', !!start.ok);
  test('start: step=captcha (got=' + start.step + ')', start.step === 'captcha');
  test('start: تصویر کپچا data-URI است', /^data:image/.test(start.captchaImageUrl || ''));
  test('start: stateToken دارد', !!start.stateToken);
  let token = start.stateToken;
  let currentUrl = start.captchaImageUrl;

  /* --- ۲) حل خودکار (OCR واقعی روی کپچای واقعی) --- */
  const solve1 = await call({ action: 'solve-captcha', captchaImageUrl: currentUrl, stateToken: token });
  console.log('  [solve#1]', JSON.stringify({ ok: solve1.ok, text: solve1.text, confidence: solve1.confidence, variant: solve1.variant }));
  test('solve: متن برگشت', !!solve1.text);
  const expected1 = issuedCaptchas[0].text;
  console.log('  [ground-truth#1]', expected1, '— ocr:', solve1.text);

  /* --- ۳) ارسال عمدی اشتباه → باید کپچای تازه + خطای کپچا برگردد --- */
  const wrong = await call({ action: 'submit', stateToken: token, captcha: 'zzzzz', passengers: [], phone: '09120000000' });
  test('submit اشتباه: ok=true و مرحله همچنان کپچا (got=' + wrong.step + ')', wrong.ok === true && wrong.step === 'captcha');
  test('submit اشتباه: captchaError پرچم خورده', !!(wrong.captchaError || (wrong.flags && wrong.flags.captchaError)));
  test('submit اشتباه: کپچای تازه (تصویر عوض شد)', !!wrong.captchaImageUrl && wrong.captchaImageUrl !== currentUrl);
  test('submit اشتباه: stateToken تازه', !!wrong.stateToken && wrong.stateToken !== token);
  if (wrong.stateToken) token = wrong.stateToken;
  if (wrong.captchaImageUrl) currentUrl = wrong.captchaImageUrl;

  /* --- ۴) حل کپچای تازه و ارسال درست → فرم مسافر --- */
  const solve2 = await call({ action: 'solve-captcha', captchaImageUrl: currentUrl, stateToken: token });
  console.log('  [solve#2]', JSON.stringify({ ok: solve2.ok, text: solve2.text, confidence: solve2.confidence, variant: solve2.variant }));
  const expected2 = currentCaptcha.text;
  console.log('  [ground-truth#2]', expected2, '— ocr:', solve2.text);
  // برای قطعیت تست، متن درستِ خود موک را ارسال می‌کنیم (رفتار سرور مهم است)
  const good = await call({ action: 'submit', stateToken: token, captcha: expected2, passengers: [{ first_name: 'الف', last_name: 'ب', national_code: '0012345679', birth_day: '1', birth_month: '1', birth_year: '1370', quota_type: 'عادی' }], phone: '09120000000' });
  test('submit درست: عبور از کپچا → فرم مسافر (got=' + good.step + ')', good.step === 'passenger_form');
  if (good.stateToken) token = good.stateToken;

  /* --- ۵) ارسال اطلاعات مسافر → صفحه پرداخت --- */
  const pay = await call({ action: 'submit', stateToken: token, captcha: null, passengers: [{ first_name: 'الف', last_name: 'ب', national_code: '0012345679', birth_day: '1', birth_month: '1', birth_year: '1370', quota_type: 'عادی' }], phone: '09120000000' });
  test('submit مسافر: رسیدن به پرداخت (got=' + pay.step + ')', pay.step === 'payment' || pay.step === 'success');

  /* --- ۷) شبیه‌سازی کامل حلقه فرانت‌اند (منطق جدید) با ۲ ردشدن اجباری ---
   * دقیقاً همان تصمیم‌های route.html: حل → اگر متن معتبر است ارسال کن
   * (حتی کم‌اعتماد) → اگر رد شد با کپچای تازه ادامه بده تا پذیرش. */
  forceWrongRemaining = 2;
  const start2 = await call({
    action: 'start',
    fields: { from_city: 'تهران', to_city: 'مشهد', date: '1404/07/10', train_number: '12345' },
    passengers: [{ first_name: 'الف', last_name: 'ب', national_code: '0012345679', birth_day: '1', birth_month: '1', birth_year: '1370', quota_type: 'عادی' }],
    train: { 'شماره قطار': '12345', 'ساعت حرکت': '10:00', 'قیمت': '1,234,567', 'نوع کوپه': '4تخته', 'شرکت': 'تست', 'ظرفیت': 5, srvc: '123456' },
    cookies: [],
  });
  test('حلقه: شروع دوباره برای شبیه‌سازی', start2.ok === true && start2.step === 'captcha');

  // باید تابع تصمیم فرانت‌اند را با همین قاعده داشته باشیم (همسان با app.js)
  const { shouldAutoSubmit } = (() => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const vm = require('vm');
    const sandbox = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(appSrc + '\n;this.__BF = BilitFast;', sandbox);
    return sandbox.__BF;
  })();
  test('app.js تابع تصمیم ارسال (shouldAutoSubmit) را صادر می‌کند', typeof shouldAutoSubmit === 'function');
  test('حالت «تا پذیرش»: حدس کم‌اعتماد هم ارسال می‌شود', shouldAutoSubmit({ ok: false, text: 'abc12' }, true) === true);
  test('حالت «تا پذیرش»: متن نامعتبر ارسال نمی‌شود', shouldAutoSubmit({ ok: true, text: '!!!' }, true) === false);
  test('حالت موردی: فقط نتیجه مطمئن ارسال می‌شود', shouldAutoSubmit({ ok: false, text: 'abc12' }, false) === false && shouldAutoSubmit({ ok: true, text: 'abc12' }, false) === true);

  let loopToken = start2.stateToken;
  let loopUrl = start2.captchaImageUrl;
  let accepted = false, iters = 0;
  const PASS1 = [{ first_name: 'الف', last_name: 'ب', national_code: '0012345679', birth_day: '1', birth_month: '1', birth_year: '1370', quota_type: 'عادی' }];
  while (!accepted && iters < 15) {
    iters++;
    const solved = await call({ action: 'solve-captcha', captchaImageUrl: loopUrl, stateToken: loopToken });
    if (!shouldAutoSubmit(solved, true)) {
      // متن نامعتبر/غایب → رفرش (مثل فرانت)
      const r = await call({ action: 'refresh-captcha', stateToken: loopToken });
      if (!r || !r.ok) break;
      loopToken = r.stateToken || loopToken;
      loopUrl = r.captchaImageUrl || r.captchaDataUri;
      continue;
    }
    const resp = await call({ action: 'submit', stateToken: loopToken, captcha: solved.text, passengers: PASS1, phone: '09120000000' });
    if (!(resp && resp.ok)) break;
    if (resp.stateToken) loopToken = resp.stateToken;
    if (resp.step !== 'captcha') { accepted = true; break; }
    if (resp.captchaImageUrl) {
      loopUrl = resp.captchaImageUrl;
    } else {
      const r = await call({ action: 'refresh-captcha', stateToken: loopToken });
      if (!r || !r.ok) break;
      loopToken = r.stateToken || loopToken;
      loopUrl = r.captchaImageUrl || r.captchaDataUri;
    }
  }
  test('حلقه «تا پذیرش»: بعد از ۲ ردشدن اجباری، سرانجام پذیرفته شد (تلاش‌ها=' + iters + ')', accepted);
  test('حلقه «تا پذیرش»: عبور نهایی به فرم مسافر یا بعد از آن', accepted);

  /* --- ۶) شبیه‌سازی حلقه فرانت‌اند با گیت فعلی (فقط وقتی حل «مطمئن» است) ---
   * این بخش نشان می‌دهد وقتی OCR اعتماد پایین دارد (ok:false) حلقه فعلی
   * هرگز چیزی ارسال نمی‌کند و فقط رفرش می‌کند. */
  console.log('\n--- تحلیل گیت اعتماد روی همه نمونه‌های واقعی ---');
  let confident = 0, notConfident = 0, correctOverall = 0;
  for (const file of sampleFiles.slice(0, 20)) {
    const buf = fs.readFileSync(path.join(SAMPLES_DIR, file));
    const dataUri = 'data:image/png;base64,' + buf.toString('base64');
    const r = await call({ action: 'solve-captcha', captchaImageUrl: dataUri, stateToken: token });
    if (r && r.ok) confident++; else notConfident++;
    if (r && r.text === LABELS[file]) correctOverall++;
  }
  console.log('  نمونه‌ها: ' + Math.min(20, sampleFiles.length) +
    ' | حل مطمئن (ok=true): ' + confident +
    ' | کم‌اعتماد (ok=false → حلقه فعلی هرگز ارسال نمی‌کند): ' + notConfident +
    ' | متن درست: ' + correctOverall);

  console.log('\nخلاصه موک: صادرشده=' + issuedCaptchas.length +
    ' ارسال‌اشتباه=' + wrongSubmits + ' پذیرفته‌شده=' + acceptedSubmits);

  server.close();
  console.log(failures ? ('\n❌ ' + failures + ' مورد ناموفق') : '\n✅ همه موارد موفق');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('خطای e2e:', e);
  process.exit(1);
});
