/* First-party, post-human-challenge reservation continuation.
 * This file has NO interaction with ARCaptcha widgets, tokens or browser cookies.
 * Only the site's own, uniquely identified form controls are ever activated.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitAutoOfficialFlow = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const SITE = 'https://safirrail.ir';
  const normalize = value => String(value || '').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[أإآ]/g, 'ا')
    .replace(/[\u200c\s]+/g, ' ').trim();
  const challenge = doc => Boolean(doc.querySelector('.arcaptcha[data-site-key],input[name="arcaptcha-token"]'));
  function origin(loc) {
    return loc?.protocol === 'https:' && loc?.hostname === 'safirrail.ir' &&
      /^\/etrain\/[a-z0-9-]+\.php$/i.test(loc?.pathname || '');
  }
  function officialAction(form, loc) {
    if (!form || String(form.method || '').toUpperCase() !== 'POST') return false;
    try {
      const url = new URL(form.getAttribute?.('action') || form.action, loc?.href || SITE + '/etrain/');
      return url.origin === SITE && /^\/etrain\/[a-z0-9-]+\.php$/i.test(url.pathname) && !url.search;
    } catch (_) { return false; }
  }
  function markerMatch(doc, selection) {
    if (!selection?.srvc) return false;
    for (const key of ['srvc','wagon']) {
      const expected = String(selection[key] || '').trim();
      const markers = Array.from(doc.querySelectorAll(`input[name="${key}"]`));
      // A missing marker is not proof of a different selection: the official
      // page may keep it only in the bound PHP session. An observed conflicting
      // marker, however, must always stop the automation.
      if (markers.length > 1 || markers.some(el => !expected || String(el.value || '').trim() !== expected)) return false;
    }
    return true;
  }
  function field(doc, name) {
    return doc.querySelector(`input[name="${name}"],input[id="${name}"]`);
  }
  function findPassengerSubmit(doc, booking, loc) {
    if (!origin(loc) || loc.pathname !== '/etrain/TresV.php' || challenge(doc))
      return {ok:false,reason:'not-verified-passenger-page'};
    if (!booking?.autoAdvance || !markerMatch(doc, booking.selection) ||
        !Array.isArray(booking.passengers) || !booking.passengers.length || booking.passengers.length > 6)
      return {ok:false,reason:'missing-booking-identity'};
    const first = field(doc, 'pid0');
    const form = first?.form || first?.closest?.('form');
    if (!officialAction(form, loc)) return {ok:false,reason:'invalid-passenger-form'};
    for (const [i, p] of booking.passengers.entries()) {
      const values = {pid:p.national_code,fn:p.first_name,ln:p.last_name,
        ruz:p.birth_day,mah:p.birth_month,sal:p.birth_year};
      for (const [key, value] of Object.entries(values)) {
        const el = field(doc, key+i);
        if (!el || el.form !== form || value == null || String(value).trim() === '' ||
            String(el.value || '').trim() !== String(value).trim())
          return {ok:false,reason:'passenger-incomplete-or-edited'};
      }
    }
    if (booking.phone && field(doc,'phone') &&
        String(field(doc,'phone').value || '').trim() !== String(booking.phone).trim())
      return {ok:false,reason:'contact-mismatch'};
    if (typeof form.checkValidity === 'function' && !form.checkValidity())
      return {ok:false,reason:'invalid-fields'};
    // SafirRail historically changes the POST target in chkForm(). Clicking
    // this exact existing control preserves official validation and events;
    // requestSubmit()/form.submit() would skip the site's click handler.
    const controls = Array.from(form.querySelectorAll('button,input')).filter(el => {
      if (!el || el.disabled || el.hidden || el.getAttribute?.('aria-disabled') === 'true') return false;
      const kind = String(el.type || '').toLowerCase();
      if (kind !== 'button' && kind !== 'submit') return false;
      return /^(?:return\s+)?chkForm\s*\(\s*\)\s*;?$/i.test(String(el.getAttribute?.('onclick') || '').trim());
    });
    return controls.length === 1 ? {ok:true,element:controls[0]} : {ok:false,reason:'unknown-passenger-control'};
  }
  const ACK_PATTERN = /^تایید شماره واگن و کوپه اختصاص یافته مورد تایید می ?باشد[.!،]?$|^شماره واگن و کوپه اختصاص یافته مورد تایید می ?باشد[.!،]?$/;
  const CONTINUE_LABELS = new Set(['تایید','تایید و ادامه','ادامه','تایید خرید','ثبت تایید']);
  function findAllocationAcknowledgement(doc, booking, loc) {
    if (!origin(loc) || !['/etrain/VerifyTck.php','/etrain/TresV.php'].includes(loc.pathname) || challenge(doc))
      return {ok:false,reason:'not-official-allocation-page'};
    if (!booking?.autoAdvance || !booking.passengerSubmitted || !markerMatch(doc,booking.selection) ||
        !(['srvc','wagon'].some(key => Array.from(doc.querySelectorAll(`input[name="${key}"]`)).length === 1)))
      return {ok:false,reason:'booking-not-ready'};
    // Only the EXACT allocated wagon/coupe acknowledgement, not a generic
    // purchase consent, marketing checkbox or CAPTCHA checkbox.
    const checkboxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));
    const matches = checkboxes.filter(el => {
      if (el.disabled || el.hidden || !el.form) return false;
      const labels = Array.from(el.labels || []);
      const nearby = labels.length ? labels.map(l => l.textContent || '') :
        [el.closest?.('label')?.textContent || ''];
      return nearby.some(s => ACK_PATTERN.test(normalize(s)));
    });
    if (matches.length !== 1) return {ok:false,reason:'missing-or-ambiguous-acknowledgement'};
    const checkbox = matches[0];
    const form = checkbox.form;
    if (!officialAction(form,loc)) return {ok:false,reason:'invalid-checkout-form'};
    const controls = Array.from(form.querySelectorAll('button,input')).filter(el => {
      if (!el || el.disabled || el.hidden || el.getAttribute?.('aria-disabled') === 'true') return false;
      if (!['button','submit'].includes(String(el.type || '').toLowerCase())) return false;
      const label = normalize(el.textContent || el.value).replace(/تأیید/g,'تایید');
      const handler = String(el.getAttribute?.('onclick') || '').trim();
      // Submit through the site's regular control and its validation. Never
      // follow hard-coded bank URLs or click a payment-entry button.
      return CONTINUE_LABELS.has(label) && (!handler || /^(?:return\s+)?chkForm\s*\(\s*\)\s*;?$/i.test(handler));
    });
    return controls.length === 1 ? {ok:true,checkbox,element:controls[0]} : {ok:false,reason:'unknown-allocation-control'};
  }
  return {findPassengerSubmit,findAllocationAcknowledgement,markerMatch,normalize};
});
