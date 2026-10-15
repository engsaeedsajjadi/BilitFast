/* Explicit user-initiated first-party reservation handoff. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitOfficialHandoff = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const OFFICIAL = 'https://safirrail.ir/etrain/TresV-auth.php';
  const KEYS = new Set(['from','to','groupWay','pathWay','fromd','tod','sex','wagon',
    'adult','shahed','child','infant','forien','passCnt','srvc']);
  function validate(data) {
    if (!data || data.url !== OFFICIAL || data.method !== 'POST' ||
        !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields))
      throw new Error('فرم رزرو معتبر نیست. در BilitFast قطار را دوباره انتخاب کنید.');
    const fields = Object.entries(data.fields);
    if (!fields.length || fields.length > 20 || !fields.some(([k,v]) => k === 'srvc' && typeof v === 'string' && v.length))
      throw new Error('شناسه قطار در فرم رزرو ناقص است.');
    for (const [k, v] of fields) {
      if (!KEYS.has(k) || (typeof v !== 'string' && typeof v !== 'number') || String(v).length > 8000 || /[\r\n]/.test(String(v)))
        throw new Error('فیلد رزرو نامعتبر است: ' + k);
    }
    return { url: OFFICIAL, method: 'POST', fields: Object.fromEntries(fields.map(([k,v]) => [k,String(v)])) };
  }
  return {validate, OFFICIAL};
});
