// api/config.js — نمایش تنظیمات فعلی (فقط‌خواندنی؛ config.json در زمان دیپلوی باندل می‌شود)
const { config } = require('../lib/core');

module.exports = (req, res) => {
  res.status(200).json(config);
};
