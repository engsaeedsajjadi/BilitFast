/* The official site owns all reservation and payment transitions.
 * Never duplicate/forge a CAPTCHA response or force a redirect to a bank.
 * This helper only chooses the site's own passenger confirmation control. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitOfficialCheckout = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const SITE = 'https://safirrail.ir';
  const VERIFY = '/etrain/VerifyTck.php';
  const PASSENGER = '/etrain/TresV.php';
  function officialAction(form) {
    if (!form || String(form.method || '').toUpperCase() !== 'POST') return null;
    try {
      const u = new URL(form.action, SITE + '/etrain/');
      if (u.origin !== SITE || ![VERIFY, PASSENGER].includes(u.pathname)) return null;
      return u.pathname;
    } catch (_) { return null; }
  }
  function controls(form) {
    return Array.from(form?.querySelectorAll?.('input[type="button"],button[type="button"],input[type="submit"],button[type="submit"]') || []);
  }
  function isConfirmControl(element) {
    if (!element || element.disabled || typeof element.click !== 'function') return false;
    const eventCode = element.getAttribute?.('onclick') || '';
    // This is the site's own passenger validation and transition to VerifyTck.
    return /\bchkForm\s*\(/i.test(eventCode);
  }
  function submitPassenger(form) {
    const action = officialAction(form);
    if (!action) return {ok:false,reason:'invalid-form'};
    if (typeof form.reportValidity === 'function' && !form.reportValidity())
      return {ok:false,reason:'invalid-fields'};
    const elements = controls(form);
    const officialControl = elements.find(isConfirmControl);
    if (officialControl) {
      officialControl.click(); // Native click executes the site's onclick=chkForm().
      return {ok:true,method:'official-chkForm'};
    }
    // If already pointed to VerifyTck.php, a native submit is safe; otherwise
    // NEVER POST passenger details back to TresV.php by guessing an action.
    if (action === VERIFY) {
      const submitter = elements.find(el=>!el.disabled && /submit/i.test(el.type || ''));
      if (submitter && typeof submitter.click === 'function') {
        submitter.click();
        return {ok:true,method:'official-submit-click'};
      }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return {ok:true,method:'official-request-submit'};
      }
    }
    // Some Safir layouts set the action through onsubmit rather than onclick.
    if (/\bchkForm\s*\(/i.test(form.getAttribute?.('onsubmit') || '') &&
        typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return {ok:true,method:'official-onsubmit'};
    }
    return {ok:false,reason:'official-control-not-found'};
  }
  function detectPage({hostname,pathname,visibleText='',hasPassenger=false,hasChallenge=false}) {
    if (hostname === 'pec.shaparak.ir' && /^\/NewIPG\//i.test(pathname)) return 'payment-page';
    if (hostname !== 'safirrail.ir' || !pathname.startsWith('/etrain/')) return 'not-official';
    if (hasChallenge) return 'awaiting-human';
    if (hasPassenger) return 'passenger-form';
    const text = String(visibleText).slice(0,15000);
    if (/ت[أا]یید\s*(?:نهایی\s*)?(?:خرید|رزرو|بلیت)|ثبت\s*نهایی\s*خرید/.test(text))
      return 'purchase-review';
    // VerifyTck can be a server-side transition or error, NOT automatically a bank page.
    if (pathname === VERIFY) return 'purchase-response';
    if (pathname === PASSENGER) return 'passenger-response';
    return 'unknown-official';
  }
  return {officialAction, submitPassenger, detectPage, VERIFY, PASSENGER};
});
