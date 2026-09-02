// تست‌های طبقه‌بندی فرم بر اساس DOM (بدون حدس/پیش‌فرض passenger_form)
// اجرا: node test/classification.test.js
const { analyzeHtml, needsAjaxCaptcha, mergeAjaxAnalysis, mapPassengerFields } = require('../lib/reserve');

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

// (9) ادغام AJAX: پوسته JS-رندر (phone + price) + پاسخ captchaAjax (کپچا + مسافر) → captcha
{
  const shell = analyzeHtml(`<form action="" method="post" name="mainFrm">
    <input type="text" name="phone"/><input type="text" name="ticPrice" value="1"/>
    <input type="hidden" name="adis" value="A"/><input type="hidden" name="ajaxResponse" value=""/>
    <script>document.getElementById("captcha").innerHTML = x;</script>
  </form>`, BASE);
  const ajax = analyzeHtml(`<form action="TresV.php" method="post" name="mainFrm">
    <input type="hidden" name="srvc" value="TOKEN"/><input type="hidden" name="captchaId" value="c1"/>
    <input type="text" name="Ksubmit" id="Ksubmit"/><img id="captchaImg" src="data:image/png;base64,xx"/>
    <input type="text" id="pid0"/><input type="text" id="ruz0"/><input type="text" id="mah0"/>
    <input type="text" id="sal0"/><input type="text" id="fn0"/><input type="text" id="ln0"/>
  </form>`, 'https://safirrail.ir/etrain/captchaAjax.php');
  const okNeed = needsAjaxCaptcha(shell) === true;
  const merged = mergeAjaxAnalysis(shell, ajax);
  const okCls = merged.classification.type === 'captcha';
  const fields = merged.passengerFields.map((f) => f.effName).join(',');
  const okFields = fields === 'phone,pid0,ruz0,mah0,sal0,fn0,ln0';
  console.log((okNeed && okCls && okFields ? 'PASS' : 'FAIL') + '  ادغام AJAX (کپچا + مسافر) → captcha  (need=' + okNeed + ' cls=' + merged.classification.type + ' fields=' + fields + ')');
  if (!(okNeed && okCls && okFields)) failures++;
}

console.log('');
if (failures) {
  console.log(failures + ' تست شکست خورد');
  process.exit(1);
} else {
  console.log('همه تست‌ها پاس شدند');
  process.exit(0);
}
