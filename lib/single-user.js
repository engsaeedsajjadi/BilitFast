// One owner account per independently licensed installation.
// This is an account-count rule, NOT hardware attestation.
'use strict';
const db = require('./db');
function enabled() {
  // The commercial web build is single-owner by default. Legacy multi-user
  // test environments may explicitly opt out; production forces it on.
  if (process.env.BILITFAST_SINGLE_USER === '1') return true;
  if (process.env.BILITFAST_SINGLE_USER === '0') return false;
  // Web preview keeps its old no-account local behavior; commercial startup
  // forces single owner. Tests can explicitly enable the production policy.
  return process.env.BILITFAST_SELF_HOSTED === '1';
}
function users() { return db.find('users', () => true); }
function state() {
  if (!enabled()) return {ok:true,enabled:false};
  const rows = users();
  if (rows.length > 1) return {ok:false,reason:'migration_required',
    error:'این دیتابیس چند حساب دارد. برای مهاجرت تک‌کاربره ابتدا پشتیبان تهیه کنید؛ هیچ حسابی خودکار حذف نمی‌شود.'};
  if (rows.length === 1 && rows[0].role !== 'admin') return {ok:false,reason:'owner_required',
    error:'حساب موجود مدیر نیست؛ پیش از تبدیل، بازیابی ایمن حساب مالک لازم است.'};
  return {ok:true,enabled:true,owner:rows[0]||null};
}
function assertReady() { const s=state(); if (!s.ok) throw new Error(s.error); return s; }
function isOwner(user) {
  if (!enabled()) return true;
  const s=state();
  return !!(s.ok && s.owner && user && user.id===s.owner.id);
}
module.exports={enabled,users,state,assertReady,isOwner};
