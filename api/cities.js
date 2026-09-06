// api/cities.js — بازگرداندن لیست نام شهرها (برای انتخاب مبدا/مقصد)
const { cityCodes } = require('../lib/core');
const { guardApi } = require('../lib/guard');

module.exports = (req, res) => {
  if (!guardApi(req, res, { name: 'cities', limit: 120, windowMs: 60000 })) return;
  res.status(200).json({ cities: Object.keys(cityCodes) });
};
