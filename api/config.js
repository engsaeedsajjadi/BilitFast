// api/config.js — نمایش تنظیمات فعلی (فقط‌خواندنی؛ config.json در زمان دیپلوی باندل می‌شود)
const { config } = require('../lib/core');
const { guardApi } = require('../lib/guard');

module.exports = (req, res) => {
  if (!guardApi(req, res, { name: 'config', limit: 60, windowMs: 60000 })) return;
  res.status(200).json(config);
};
