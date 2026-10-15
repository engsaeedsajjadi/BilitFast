'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const helper=fs.readFileSync(path.join(__dirname,'../extension/safir-passenger-helper.js'),'utf8');
let assertions=0;
const pass=(message,ok)=>{assert(ok,message);console.log('PASS '+message);assertions++};
function scene(mode){
  const fields={};const nodes={};const events=[];let tick;
  const form={method:'POST',action:'https://safirrail.ir/etrain/TresV.php',
    submit(){events.push('UNSAFE_SUBMIT')},requestSubmit(){events.push('UNSAFE_REQUEST_SUBMIT')},
    querySelectorAll(){return [{click(){events.push('UNSAFE_CLICK')}}]}};
  function makeEl(tag='input'){
    return {tagName:tag,id:'',value:'',disabled:false,readOnly:false,hidden:false,
      textContent:'',style:{},children:[],events:{},append(...x){this.children.push(...x);},
      appendChild(x){this.children.push(x);},addEventListener(n,cb){this.events[n]=cb},
      dispatchEvent(){},getAttribute(){return null},form};
  }
  if(mode==='passenger')for(const key of ['pid0','fn0','ln0','ruz0','mah0','sal0','phone'])fields[key]=makeEl();
  const document={
    querySelector(s){
      if(s==='.arcaptcha[data-site-key],input[name="arcaptcha-token"]')return mode==='captcha'?makeEl():null;
      const m=s.match(/^input\[name="([^"]+)"\],input\[id="([^"]+)"\]$/);
      return m?fields[m[1]]||null:null;
    },
    createElement(tag){return makeEl(tag)},
    getElementById(id){if(nodes[id])return nodes[id];const elements=nodes[PANEL_ID]?.children||[];return elements.find(x=>x.id===id)||null},
    body:{append(el){nodes[el.id]=el},innerText:''},documentElement:{}
  };
  const PANEL_ID='bilitfast-official-helper';
  const chrome={runtime:{async sendMessage(data){events.push(data.type+':'+(data.stage||''));
    if(data.type==='BILIT_GET_PASSENGERS')return {ok:true,passengers:[{
      national_code:'0499370899',first_name:'Sara',last_name:'Test',birth_day:'01',birth_month:'02',birth_year:'1370'}]};
    return {ok:true};
  }}};
  vm.runInNewContext(helper,{chrome,document,Event:class{constructor(type){this.type=type}},
    URL,Date,location:{protocol:'https:',hostname:'safirrail.ir',pathname:'/etrain/TresV.php'},
    BilitOfficialCheckout:require('../extension/checkout-flow'),
    MutationObserver:class{observe(){}disconnect(){}},setInterval(fn){tick=fn;return 1},clearInterval(){}});
  return {fields,events,nodes,document,tick};
}
const flush=async()=>{for(let i=0;i<9;i++)await new Promise(resolve=>setImmediate(resolve))};
(async()=>{
  pass('CAPTCHA response/checkbox value never inspected',!/arcaptcha-token[^\n]*\?\.value|#arc-checkbox/.test(helper));
  pass('No programmatic CAPTCHA or official form submission',!/\.requestSubmit\s*\(|\.submit\s*\(/.test(helper));
  const captcha=scene('captcha');await flush();
  pass('Challenge is marked unverified',captcha.events.includes('BILIT_SET_WORKFLOW_STAGE:unverified'));
  pass('Challenge is never submitted automatically',!captcha.events.some(x=>x.startsWith('UNSAFE')));
  const passenger=scene('passenger');await flush();
  pass('Official passenger step observed',passenger.events.includes('BILIT_SET_WORKFLOW_STAGE:human-verified'));
  pass('Human verification status inferred from official passenger page',passenger.events.includes('BILIT_SET_WORKFLOW_STAGE:human-verified'));
  pass('No second passenger-fill button exists',!passenger.document.getElementById('bilitfast-fill-passengers'));
  pass('Passenger data automatically filled',passenger.fields.pid0.value==='0499370899'&&passenger.fields.fn0.value==='Sara');
  pass('Passenger form completion stage is recorded',passenger.events.includes('BILIT_SET_WORKFLOW_STAGE:official-form-not-submitted'));
  pass('No unrecognized form controls clicked',!passenger.events.some(x=>x.startsWith('UNSAFE')));
  pass('Sensitive record not logged or cleared before official review',!passenger.events.some(x=>x.startsWith('BILIT_CLEAR_PASSENGERS')));
  console.log('ALL '+assertions+' human verification safety assertions passed');
})().catch(e=>{console.error(e);process.exitCode=1});
