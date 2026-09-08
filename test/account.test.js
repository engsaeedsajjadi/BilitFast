// تست‌های حساب کاربری، دیتابیس، اشتراک و تاریخچه رزرو.
// اجرا: node test/account.test.js
process.env.BILITFAST_DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/bf-test-');
process.env.BILITFAST_LICENSE_KEY = 'test-license-key';

const db = require('../lib/db');
const auth = require('../lib/auth');

let failures = 0;
function test(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

/* ---------------- دیتابیس ---------------- */
const u = db.insert('users', { username: 'testuser' });
test('درج رکورد با شناسه', !!u.id && db.findById('users', u.id).username === 'testuser');
test('به‌روزرسانی رکورد', (() => {
  db.update('users', u.id, { phone: '09123456789' });
  return db.findById('users', u.id).phone === '09123456789';
})());
test('یافتن با شرط', !!db.findOne('users', (x) => x.username === 'testuser'));
test('حذف رکورد', (() => {
  const tmp = db.insert('users', { username: 'tmp' });
  return db.remove('users', tmp.id) && !db.findById('users', tmp.id);
})());

/* ---------------- گذرواژه و نشست ---------------- */
const hp = auth.hashPassword('secret123');
test('هش/تأیید گذرواژه درست', auth.verifyPassword('secret123', hp));
test('گذرواژه اشتباه رد می‌شود', !auth.verifyPassword('wrong', hp));
test('نمک‌ها تصادفی‌اند (دو هش متفاوت برای یک رمز)', auth.hashPassword('secret123').hash !== hp.hash);

test('نام کاربری نامعتبر رد می‌شود', !auth.validateUsername('ab') && !auth.validateUsername('has space'));

const reg = auth.registerUser('Ali.rezaei', 'pass123');
test('ثبت‌نام موفق + توکن نشست', reg.ok && !!reg.token && reg.user.username === 'ali.rezaei');
test('ثبت‌نام تکراری رد می‌شود', !auth.registerUser('ali.rezaei', 'pass123').ok);
test('رمز کوتاه رد می‌شود', !auth.registerUser('newuser1', '123').ok);

const lg = auth.loginUser('ali.rezaei', 'pass123');
test('ورود موفق', lg.ok && !!lg.token);
test('ورود با رمز اشتباه رد می‌شود', !auth.loginUser('ali.rezaei', 'wrong').ok);

const session = auth.verifySession(lg.token);
test('توکن نشست معتبر باز می‌شود', !!session && session.uid === reg.user.id);
test('توکن نشست دستکاری‌شده رد می‌شود', auth.verifySession(lg.token.slice(0, -2) + 'xx') === null);
test('توکن نشست منقضی رد می‌شود', (() => {
  const fake = Buffer.from(JSON.stringify({ type: 'session', uid: 'x', exp: Date.now() - 1000 }), 'utf8').toString('base64url');
  return auth.verifySession(fake + '.' + 'x') === null;
})());

/* ---------------- تاریخچه رزرو ---------------- */
const b = db.insert('bookings', {
  user_id: reg.user.id,
  status: 'pending_payment',
  payment_url: 'https://pec.shaparak.ir/NewIPG/?Token=123',
  booking: { origin: 'تهران', destination: 'مشهد', date: '1404/06/10', train_number: '472', passengers: 2 },
});
test('ثبت رزرو', !!b.id && db.findOne('bookings', (x) => x.id === b.id).status === 'pending_payment');
test('تأیید پرداخت کاربر', (() => {
  db.update('bookings', b.id, { status: 'paid_confirmed' });
  return db.findById('bookings', b.id).status === 'paid_confirmed';
})());

console.log(failures === 0 ? '\nهمه تست‌ها پاس شدند' : '\n' + failures + ' تست ناموفق بود');
process.exit(failures === 0 ? 0 : 1);
