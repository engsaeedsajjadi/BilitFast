// تست‌های طبقه‌بندی فرم بر اساس DOM (بدون حدس/پیش‌فرض passenger_form)
// اجرا: node test/classification.test.js
const { analyzeHtml, needsAjaxCaptcha, parseCaptchaAjaxResponse, mergeCaptchaAjax, mapPassengerFields } = require('../lib/reserve');

const BASE = 'https://safirrail.ir/etrain/TresV.php';
let failures = 0;

function test(name, html, expect) {
  const a = analyzeHtml(html, BASE);
  const cls = a.classification;
  const ok = cls.type === expect.type &&
    (expect.confidence === undefined || cls.confidence === expect.confidence);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  → type=' + cls.type + ' (expected ' + expect.type + ') confidence=' + cls.confidence);
  if (!ok) {
    failures++;
    console.log('       evidence:', JSON.stringify(cls.evidence));
    console.log('       inputCount:', a.diag.inputCount, ' inputs:', a.diag.inputs.map((x) => x.name).join(','));
  }
  return ok;
}

// (1) پنج ورودی ناآشنا → نباید passenger_form/passenger باشد
test('پنج ورودی ناآشنا (wagon/coupe) → intermediate', `<html><body><form action="${BASE}" method="post">
  <input type="hidden" name="srvc" value="S370"/>
  <input type="hidden" name="from" value="1"/>
  <select name="wagon"><option>1</option></select>
  <select name="coupe"><option>2</option></select>
  <input type="text" name="seat"/>
</form></body></html>`, { type: 'intermediate', confidence: 0.5 });

// (2) pid/ruz/mah/sal/fn/ln/phone → passenger_form
test('فرم مسافر (pid/ruz/mah/sal/fn/ln/phone) → passenger', `<html><body><form action="${BASE}" method="post">
  <input type="hidden" name="srvc" value="S370"/>
  <input type="text" name="pid0"/>
  <input type="text" name="ruz0"/>
  <input type="text" name="mah0"/>
  <input type="text" name="sal0"/>
  <input type="text" name="fn0"/>
  <input type="text" name="ln0"/>
  <input type="text" name="phone"/>
</form></body></html>`, { type: 'passenger' });

// (3) تصویر کپچا + ورودی کپچا → captcha
test('تصویر کپچا + ورودی → captcha', `<html><body><form action="${BASE}" method="post">
  <input type="hidden" name="srvc" value="S370"/>
  <img src="/etrain/kcaptcha/index.php"/>
  <input type="text" name="captcha_code"/>
</form></body></html>`, { type: 'captcha', confidence: 0.9 });

// (3b) کپچای data-URI + ورودی Ksubmit (ساختار واقعی TresV.php) → captcha
test('کپچای data-URI + Ksubmit → captcha', `<html><body><form action="TresV.php" method="post" name="mainFrm">
  <input type="text" name="Ksubmit" id="Ksubmit"/>
  <img id="captchaImg" src="data:image/png;base64,iVBORw0KGgo="/>
  <input type="hidden" name="captchaId" value="cap123"/>
  <input type="text" id="pid0"/><input type="text" id="ruz0"/><input type="text" id="mah0"/>
  <input type="text" id="sal0"/><input type="text" id="fn0"/><input type="text" id="ln0"/>
  <input type="text" name="phone"/>
</form></body></html>`, { type: 'captcha', confidence: 0.9 });

// (4) نشانگر پرداخت → payment
test('نشانگر پرداخت → payment', `<html><body><form action="https://shaparak.ir/pay/x" method="post"></form><p>درگاه پرداخت</p></body></html>`, { type: 'payment', confidence: 0.9 });

// (5) نشانگر ورود → login_required
test('نشانگر ورود → login', `<html><body><form action="/fa/UserAut.php" method="post"></form><p>ورود به سامانه شناسه: گذرواژه:</p></body></html>`, { type: 'login', confidence: 0.95 });

// (6) نشانگر موفقیت → success
test('نشانگر موفقیت → success', `<html><body><p>رزرو با موفقیت انجام شد. کد رهگیری: 12345</p></body></html>`, { type: 'success', confidence: 0.95 });

// (7) فرم مسافر با id به‌جای name (ساختار واقعی TresV.php صفیر ریل) → passenger
test('فرم مسافر با id (pid0/ruz0/... + phone) → passenger', `<html><body><form action="${BASE}" method="post">
  <input type="text" name="phone" id="phone"/>
  <input type="text" id="pid0"/>
  <input type="text" id="ruz0"/>
  <input type="text" id="mah0"/>
  <input type="text" id="sal0"/>
  <input type="text" id="fn0"/>
  <input type="text" id="ln0"/>
  <input type="hidden" name="totalPrice" value="15200000"/>
  <input type="hidden" name="adis" value="x"/>
  <input type="hidden" name="ajaxResponse" value=""/>
</form></body></html>`, { type: 'passenger' });

// (8) فقط فیلد hidden + دکمه → unknown (هرگز passenger_form)
test('فقط hidden + دکمه → unknown', `<html><body><form action="${BASE}" method="post">
  <input type="hidden" name="srvc" value="S370"/>
  <input type="hidden" name="from" value="1"/>
  <button type="submit">ادامه</button>
</form></body></html>`, { type: 'unknown', confidence: 0 });

// (9) پاسخ واقعی captchaAjax.php «captchaId@base64PNG» → تجزیه + ادغام → captcha
{
  const shell = analyzeHtml(`<form action="" method="post" name="mainFrm">
    <input type="text" name="phone"/><input type="text" name="ticPrice" value="1"/>
    <input type="hidden" name="adis" value="A"/><input type="hidden" name="ajaxResponse" value=""/>
    <script>document.getElementById("captcha").innerHTML = x;</script>
  </form>`, BASE);

  const ajaxText = '152092113@iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const parsed = parseCaptchaAjaxResponse(ajaxText);
  const okParse = !!(parsed && parsed.captchaId === '152092113' && /^data:image\/png;base64,/.test(parsed.dataUri));
  const okNeed = needsAjaxCaptcha(shell) === true;
  const merged = mergeCaptchaAjax(shell, parsed);
  const okCls = merged.classification.type === 'captcha';
  const okCaptchaId = merged.hiddenFields.captchaId === '152092113';
  const ok = okParse && okNeed && okCls && okCaptchaId;
  console.log((ok ? 'PASS' : 'FAIL') + '  تجزیه captchaAjax.php (captchaId@base64) → captcha  (parse=' + okParse + ' need=' + okNeed + ' cls=' + merged.classification.type + ' captchaId=' + merged.hiddenFields.captchaId + ')');
  if (!ok) failures++;
}

// (9b) پاسخ غیرمنتظره (HTML/خطا) → parseCaptchaAjaxResponse باید null برگرداند
{
  const htmlResp = '<html><body>خطا: نشست نامعتبر</body></html>';
  const okNull = parseCaptchaAjaxResponse(htmlResp) === null;
  const okNullEmpty = parseCaptchaAjaxResponse('') === null;
  console.log((okNull && okNullEmpty ? 'PASS' : 'FAIL') + '  پاسخ غیرمنتظره captchaAjax → null  (html=' + okNull + ' empty=' + okNullEmpty + ')');
  if (!(okNull && okNullEmpty)) failures++;
}

// (10) صفحه کپچای واقعی TresV-auth.php (Ksubmit + captchaId + captchaImg خالی)
//      → needsAjaxCaptcha درست → ادغام captchaAjax → captcha
{
  const page = analyzeHtml(`<form action="TresV.php" method="post" name="mainFrm">
    <input type="text" name="Ksubmit" id="Ksubmit"/>
    <input type="hidden" name="ajaxResponse" id="ajaxResponse"/>
    <input type="hidden" name="captchaId" id="captchaId"/>
    <input type="button" onclick="captchaNew();"/>
    <img id="captchaImg" src=""/>
    <input type="hidden" name="srvc" value="TOKEN"/>
    <input type="hidden" name="passCnt" value="1"/>
    <input type="hidden" name="from" value="1"/>
    <input type="hidden" name="to" value="191"/>
    <script>captchaNew();</script>
  </form>`, 'https://safirrail.ir/etrain/TresV-auth.php');
  const okAction = page.mainFormAction === 'TresV.php';
  const okInput = page.captchaInputName === 'Ksubmit';
  const okNeed = needsAjaxCaptcha(page) === true;
  const merged = mergeCaptchaAjax(page, parseCaptchaAjaxResponse('9@iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='));
  const okCls = merged.classification.type === 'captcha';
  const ok = okAction && okInput && okNeed && okCls;
  console.log((ok ? 'PASS' : 'FAIL') + '  صفحه کپچای TresV-auth.php → captcha  (action=' + page.mainFormAction + ' input=' + page.captchaInputName + ' need=' + okNeed + ' cls=' + merged.classification.type + ')');
  if (!ok) failures++;
}

// (11) absoluteUrl (قبلاً تعریف‌نشده بود → ReferenceError در جریان رزرو)
{
  const { absoluteUrl } = require('../lib/reserve');
  const a1 = absoluteUrl('https://safirrail.ir/etrain/TresV.php', 'https://safirrail.ir/x') === 'https://safirrail.ir/etrain/TresV.php';
  const a2 = absoluteUrl('TresV.php', 'https://safirrail.ir/etrain/captchaAjax.php') === 'https://safirrail.ir/etrain/TresV.php';
  const a3 = absoluteUrl('/NewIPG/ProcessPayment', 'https://safirrail.ir/etrain/VerifyTck.php') === 'https://safirrail.ir/NewIPG/ProcessPayment';
  const ok = a1 && a2 && a3;
  console.log((ok ? 'PASS' : 'FAIL') + '  absoluteUrl (absolute/relative/root-relative)');
  if (!ok) failures++;
}

// (12) دکمه‌ها (type=button/submit، نام خالی یا srchC) نباید فیلد مسافر شوند
//      — این باگ باعث می‌شد کد ملی/تاریخ تولد به نام دکمه‌ها نسبت داده شود
//        و بدنه POST خراب شود (خطای 101 سرور).
{
  const page = analyzeHtml(`<form action="TresV.php" method="post" name="mainFrm">
    <input type="text" name="Ksubmit" id="Ksubmit"/>
    <input type="hidden" name="captchaId" value="c1"/>
    <input type="button" onclick="captchaNew();"/>
    <input type="submit" name="srchC" id="srchC"/>
    <input type="button" onclick="document.location='index.php';"/>
    <input type="hidden" name="srvc" value="TOKEN"/>
    <input type="hidden" name="passCnt" value="1"/>
  </form>`, 'https://safirrail.ir/etrain/TresV-auth.php');
  const pf = page.passengerFields.map((f) => f.effName);
  const ok = pf.length === 0;
  console.log((ok ? 'PASS' : 'FAIL') + '  دکمه‌ها فیلد مسافر نشوند  (passengerFields=' + pf.join(',') + ')');
  if (!ok) failures++;
}

// (13) استخراج پیام خطای سرور از alert (مثل 101-متاسفانه...)
//      + alert داخل تعریف تابع (setPayment) نباید خطای واقعی شمرده شود
{
  const page = analyzeHtml(`<html><body>
    <script>function setPayment(isok){ if(!isok){ alert('عبارت امنیتی صحیح نمیباشد'); } }</script>
    <script>alert('101-متاسفانه ارائه سرویس رفت درخواست شده امکان‌پذیر نمی‌باشد');document.location='index.php'</script>
  </body></html>`, 'https://safirrail.ir/etrain/TresV.php');
  const okFirst = page.serverMessages.length > 0 && /101/.test(page.serverMessages[0]);
  const okNoFalsePositive = page.serverMessages.every((m) => !/عبارت امنیتی/.test(m));
  const ok = okFirst && okNoFalsePositive;
  console.log((ok ? 'PASS' : 'FAIL') + '  استخراج alert سرور (بدون false-positive)  (serverMessages=' + JSON.stringify(page.serverMessages) + ')');
  if (!ok) failures++;
}

console.log('');
if (failures) {
  console.log(failures + ' تست شکست خورد');
  process.exit(1);
} else {
  console.log('همه تست‌ها پاس شدند');
  process.exit(0);
}
