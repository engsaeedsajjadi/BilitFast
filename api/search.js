// api/search.js — یک تلاش جستجو (پورت از Worker.do_one_attempt)
const { searchOnce } = require('../lib/core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const result = await searchOnce(body);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
