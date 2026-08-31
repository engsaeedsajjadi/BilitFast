// api/reserve.js — ساخت فرم رزرو (پورت از perform_reservation)
const { buildReserveForm } = require('../lib/core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const result = buildReserveForm({
      fields: body.fields,
      passengers: body.passengers,
      train: body.train,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
