// One license per independently hosted BilitFast installation. No vendor server.
// The seller signs an offline Ed25519 code; the customer's server has ONLY
// the public key. This cannot be tamper-proof on infrastructure controlled by
// the buyer. Production storage must be backed up together with the app keys.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyOfflineCode, verifyMigrationCode } = require('./vendor-license');
const { machineIdentity } = require('./host-machine');
const TRIAL_MS = 72 * 60 * 60 * 1000;
const CLOCK_GRACE_MS = 5 * 60 * 1000;
function enabled() { return process.env.BILITFAST_SELF_HOSTED === '1'; }
function filePath() { return path.join(process.env.BILITFAST_DATA_DIR || path.join(__dirname,'..','data'), 'installation.json'); }
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), {mode:0o600,flag:'wx'});
  try { fs.renameSync(tmp,file); } catch (e) { try {fs.unlinkSync(tmp);} catch(_){} throw e; }
}
function initial() {
  const f = filePath();
  if (!fs.existsSync(f)) {
    // 'wx' means an existing file is never silently reset.
    const rec = {v:2,instanceId:crypto.randomBytes(16).toString('hex'),machineHash:machineIdentity(),installedAt:new Date().toISOString(),lastSeen:Date.now(),license:null};
    fs.mkdirSync(path.dirname(f),{recursive:true,mode:0o700});
    try { fs.writeFileSync(f,JSON.stringify(rec,null,2),{flag:'wx',mode:0o600}); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return read();
}
function read() {
  let r;
  try { r = JSON.parse(fs.readFileSync(filePath(),'utf8')); }
  catch (e) { throw new Error('رکورد نصب وب قابل خواندن نیست. نسخه پشتیبان را بازیابی کنید؛ دیتای نصب را حذف نکنید.'); }
  if (!r || ![1,2].includes(r.v) || !/^[0-9a-f]{32}$/.test(r.instanceId||'') || !Number.isFinite(Date.parse(r.installedAt)) ||
      Date.parse(r.installedAt)>Date.now()+CLOCK_GRACE_MS || !Number.isFinite(r.lastSeen)) {
    throw new Error('ثبت نصب وب معتبر نیست؛ اطلاعات ذخیره‌شده را بررسی و از پشتیبان بازیابی کنید.');
  }
  if (r.v === 1) {
    throw new Error('نصب قدیمی فاقد اتصال به دستگاه است؛ پس از پشتیبان‌گیری مهاجرت کنترل‌شده را اجرا کنید.');
  }
  if (!/^[0-9a-f]{64}$/.test(r.machineHash || '')) {
    throw new Error('رکورد اتصال نصب به میزبان معتبر نیست.');
  }
  if (!crypto.timingSafeEqual(Buffer.from(r.machineHash,'hex'),Buffer.from(machineIdentity(),'hex'))) {
    throw new Error('این نصب به سیستم دیگری تعلق دارد؛ انتقال پوشه داده مجوز را منتقل نمی‌کند.');
  }
  return r;
}
function migrateLegacy(code) {
  if (process.env.BILITFAST_MIGRATE_LEGACY_INSTALLATION !== '1')
    throw new Error('برای مهاجرت قدیمی، تایید صریح BILITFAST_MIGRATE_LEGACY_INSTALLATION=1 لازم است.');
  const file = filePath();
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record || record.v !== 1 || !/^[0-9a-f]{32}$/.test(record.instanceId || ''))
    throw new Error('این نصب قابل مهاجرت از نسخه قدیمی نیست.');
  // Seller must sign the actual host fingerprint and old installation ID;
  // toggling a local environment variable cannot authorize migration.
  const hostHash = machineIdentity();
  const approval = verifyMigrationCode(code, record.instanceId, hostHash);
  if (!approval.ok) throw new Error('مجوز مهاجرت فروشنده رد شد: ' + approval.error);
  const backup = file + '.pre-machine-binding-' + Date.now() + '.bak';
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  record.v = 2;
  record.machineHash = hostHash;
  atomicWrite(file, record);
  return { ok:true, backup };
}
function status(now=Date.now()) {
  if (!enabled()) return {state:'disabled',allowed:false};
  const r=read();
  if (now+CLOCK_GRACE_MS < r.lastSeen) return {state:'clock_invalid',allowed:false,deviceId:r.instanceId,
      message:'ساعت سرور عقب رفته است؛ ساعت میزبان را اصلاح کنید.'};
  if (now>r.lastSeen+60000) {r.lastSeen=now; atomicWrite(filePath(),r);}
  if (r.license && typeof r.license.code==='string') {
    const valid=verifyOfflineCode(r.license.code,r.instanceId,{alreadyRedeemed:true});
    if (valid.ok) return {state:'activated',allowed:true,deviceId:r.instanceId,instanceId:r.instanceId,
      message:'مجوز دائمی این استقرار فعال است.',source:'selfhost'};
  }
  const expiresAt=Date.parse(r.installedAt)+TRIAL_MS;
  const remainingMs=Math.max(0,expiresAt-now);
  return {state: remainingMs ? 'active':'expired',allowed:remainingMs>0,deviceId:r.instanceId,
    instanceId:r.instanceId,installedAt:r.installedAt,expiresAt:new Date(expiresAt).toISOString(),
    remainingMs,trialDays:3,source:'selfhost',message:remainingMs?'دوره آزمایشی ۷۲ساعته استقرار فعال است.':'دوره آزمایشی استقرار پایان یافته است.'};
}
function redeem(code) {
  const r=read();
  const checked=verifyOfflineCode(code,r.instanceId,{alreadyRedeemed:false});
  if(!checked.ok) return checked;
  // A duplicate activation should not change an existing installation license.
  if (r.license && verifyOfflineCode(r.license.code,r.instanceId,{alreadyRedeemed:true}).ok)
    return {ok:false,error:'این استقرار از قبل مجوز دائمی دارد.'};
  r.license={code:String(code).trim(),redeemedAt:new Date().toISOString(),licenseId:checked.payload.licenseId};
  r.lastSeen=Math.max(r.lastSeen,Date.now());
  atomicWrite(filePath(),r);
  return {ok:true,message:'استقرار BilitFast به صورت دائمی فعال شد.',instanceId:r.instanceId};
}
module.exports={enabled,initial,read,status,redeem,migrateLegacy,filePath,TRIAL_MS};
