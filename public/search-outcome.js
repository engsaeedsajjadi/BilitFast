/* BilitFast search response categorization. Independent of CAPTCHA implementation.
 * A valid empty search response is NOT a failure. No CAPTCHA tokens are read.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BilitSearchOutcome = api;
})(typeof globalThis === 'object' ? globalThis : null, function () {
  'use strict';
  function classify(data) {
    if (!data || typeof data !== 'object') return 'unexpected';
    // BilitFast's own owner login (not the SafirRail session) is missing/expired.
    if (data.appLoginRequired === true) return 'app_login_required';
    // Explicit upstream blockers win even if an adapter accidentally sets ok.
    if (data.sessionInvalid === true || data.loginRequired === true || data.reason === 'session_required')
      return 'session_required';
    if (data.captchaRequired === true || data.captchaInvalid === true || data.reason === 'captcha_required')
      return 'captcha_required';
    if (data.ok === true) {
      if (!Array.isArray(data.trains)) return 'unexpected';
      if (data.trains.length) return 'found';
      if (data.availabilityStatus === 'availability_unverified') return 'availability_unverified';
      if (data.availabilityStatus === 'no_match') return 'no_match';
      return 'no_capacity';
    }
    // Some upstream adapters explicitly encode a no-capacity response as !ok.
    if (data.noCapacity === true || data.code === 'NO_CAPACITY' || data.reason === 'no_capacity')
      return 'no_capacity';
    if (data.captchaRequired === true || data.captchaInvalid === true || data.reason === 'captcha_required')
      return 'captcha_required';
    if (data.sessionInvalid === true || data.loginRequired === true || data.sessionRequired === true ||
        data.reason === 'session_required' || data.reason === 'not_logged_in')
      return 'session_required';
    // /api/search may wrap an upstream transient error in HTTP 400.
    // Explicit upstream flags take precedence over that wrapper status.
    if (data.licenseRequired === true || data.quotaExceeded === true ||
        data.reason === 'invalid_input' || data.fatal === true ||
        data.httpStatus === 401 || data.httpStatus === 402 || data.httpStatus === 403 ||
        data.httpStatus === 422)
      return 'blocked';
    if (data.netError === true || data.transient === true) return 'transport_error';
    if (data.httpStatus === 400) return 'blocked';
    // Retry/backoff applies ONLY to explicit network errors, service errors,
    // and actual request throttling. Empty inventory is never throttling.
    if ([408, 425, 429, 500, 502, 503, 504].includes(Number(data.httpStatus)))
      return 'transport_error';
    return 'unexpected';
  }
  return Object.freeze({ classify });
});
