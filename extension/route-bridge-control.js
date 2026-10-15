/* global chrome */
'use strict';
// Exact origin installed only after explicit, successful cookie pairing.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BilitRouteBridgeControl = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function validateOrigin(value) {
    const u = new URL(value);
    const dev = u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname) && u.port === '3000';
    const prod = u.protocol === 'https:' && u.hostname !== 'safirrail.ir' &&
      !u.hostname.endsWith('.safirrail.ir') && u.hostname !== 'localhost' &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname);
    if (!dev && !prod || u.origin !== value || u.username || u.password) throw new Error('Invalid BilitFast origin');
    return u;
  }
  function matches(origin, tabUrl) {
    try {
      const u = validateOrigin(origin), tab = new URL(tabUrl);
      return tab.origin === u.origin && tab.pathname === '/route.html';
    } catch (_) { return false; }
  }
  async function install(chromeApi, origin, tabId) {
    const u = validateOrigin(origin);
    const matchesPattern = u.protocol + '//' + u.hostname + '/*';
    const permission = await chromeApi.permissions.contains({origins:[matchesPattern]});
    if (!permission) throw new Error('Missing customer-origin permission');
    await chromeApi.scripting.unregisterContentScripts({ids:['bilit-route-bridge']}).catch(()=>{});
    await chromeApi.scripting.registerContentScripts([{id:'bilit-route-bridge',
      matches:[matchesPattern],js:['route-bridge.js'],runAt:'document_idle',persistAcrossSessions:true}]);
    await chromeApi.storage.local.set({bilitTrustedOrigin:origin});
    if (Number.isSafeInteger(tabId)) {
      const tab = await chromeApi.tabs.get(tabId);
      if (matches(origin,tab.url)) await chromeApi.scripting.executeScript({target:{tabId},files:['route-bridge.js']});
    }
  }
  return {validateOrigin,matches,install};
});
