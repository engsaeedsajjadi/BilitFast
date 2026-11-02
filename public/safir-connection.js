/* BilitFast 3.10: direct, user-initiated in-browser connection.
 * No PIN, polling, or server-side staging of SafirRail credentials.
 */
(function(){
  'use strict';
  const state=document.getElementById('conn-state');
  const back=document.getElementById('return-to-route');
  function update(){
    const cookies=BilitFast.getCookies();
    const present=BilitFast.hasSessionCookie(cookies);
    state.dataset.state=present?'ok':'idle';
    state.textContent=present?
      '✓ نشست سفیر ریل در همین تب دریافت شد. اعتبار واقعی هنگام رزرو در سایت رسمی مشخص می‌شود.':
      'نشست هنوز به این تب نرسیده است؛ در تب رسمی سفیر ریل وارد شوید و یک بار افزونه BilitFast را بزنید.';
    if(present){
      const ret=new URLSearchParams(location.search).get('return');
      if(ret&&/^route\.html\?id=[1-9][0-9]*$/.test(ret)){
        back.hidden=false;
        back.onclick=()=>location.assign(ret);
      }
    }
  }
  document.getElementById('btn-ext-sync').addEventListener('click',update);
  window.addEventListener('bilitfast-direct-session-ready',update);
  window.addEventListener('pageshow',update);
  update();
})();
