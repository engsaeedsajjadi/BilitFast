// api/bookings.js — تاریخچه رزروها و تأیید نتیجه پرداخت
// اکشن‌ها:
//   save    → ثبت رزرو در لحظه رسیدن به مرحله پرداخت (نیازمند نشست)
//   result  → ثبت نتیجه پرداخت از دید کاربر (پرداخت کردم / ناموفق بود)
//   list    → تاریخچه رزروهای کاربر
const { getSessionUser } = require('../lib/auth');
const { guardApi } = require('../lib/guard');
const db = require('../lib/db');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

const VALID_RESULTS = {
  paid: 'paid_confirmed',
  failed: 'payment_failed',
  unknown: 'unknown',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'bookings', limit: 120, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = body.action || 'list';
  const user = getSessionUser(req, body);
  if (!user) {
    return res.status(200).json({ ok: false, loggedIn: false, error: 'برای ذخیره تاریخچه رزرو، ابتدا وارد حساب خود شوید.' });
  }

  try {
    if (action === 'save') {
      const booking = (body.booking && typeof body.booking === 'object') ? body.booking : {};
      const rec = db.insert('bookings', {
        user_id: user.id,
        status: 'pending_payment',
        payment_url: String(body.paymentUrl || '').slice(0, 1000),
        workflow_id: String(body.workflow_id || '').slice(0, 64) || null,
        booking: {
          origin: String(booking.origin || ''),
          destination: String(booking.destination || ''),
          date: String(booking.date || ''),
          time: String(booking.time || ''),
          company: String(booking.company || ''),
          train_number: String(booking.train_number || ''),
          train_type: String(booking.train_type || ''),
          passengers: Number(booking.passengers) || 0,
          ticket_price: Number(booking.ticket_price) || 0,
          total_price: body.totalPrice !== undefined ? Number(body.totalPrice) || null : null,
        },
      });
      return res.status(200).json({ ok: true, id: rec.id });
    }

    if (action === 'result') {
      const rec = db.findOne('bookings', (b) => b.id === body.id && b.user_id === user.id);
      if (!rec) return res.status(200).json({ ok: false, error: 'رزرو مورد نظر یافت نشد.' });
      const result = VALID_RESULTS[body.result];
      if (!result) return res.status(400).json({ ok: false, error: 'نتیجه نامعتبر است.' });
      db.update('bookings', rec.id, { status: result });
      return res.status(200).json({ ok: true, status: result });
    }

    if (action === 'list') {
      const items = db
        .find('bookings', (b) => b.user_id === user.id)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, 100);
      return res.status(200).json({ ok: true, items });
    }

    return res.status(400).json({ ok: false, error: 'اکشن ناشناخته: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
