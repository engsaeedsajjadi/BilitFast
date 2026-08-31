// api/cities.js — بازگرداندن لیست نام شهرها (برای انتخاب مبدا/مقصد)
const { cityCodes } = require('../lib/core');

module.exports = (req, res) => {
  res.status(200).json({ cities: Object.keys(cityCodes) });
};
