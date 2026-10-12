// -*- coding: utf-8 -*-
/**
 * api/admin-users.js — مدیریت کاربران، فقط برای نقش admin.
 *
 * اقدام‌ها:
 *   list      → فهرست کاربران (بدون هش گذرواژه و بدون اعتبارنامه صفیر)
 *   create    → ساخت کاربر (اگر گذرواژه ندهید، یکی امن تولید می‌شود)
 *   update    → تغییر نقش/وضعیت/انقضا/سهمیه/نام نمایشی
 *   reset-password → گذرواژه تازه + ابطال نشست‌های باز
 *   delete    → حذف کاربر
 *   bootstrap → ساخت نخستین ادمین، فقط وقتی هیچ ادمینی وجود ندارد
 *
 * درباره bootstrap: بدون آن روی یک نصب تازه هیچ راهی برای ساختن ادمین نیست
 * (مرغ و تخم‌مرغ). به محض اینکه یک ادمین ساخته شد، این اقدام برای همیشه
 * بسته می‌شود و 403 می‌دهد.
 */

const crypto = require('crypto');
const { guardApi } = require('../lib/guard');
const { requireAdmin } = require('../lib/apiauth');
const { registerUser, hashPassword, validateUsername } = require('../lib/auth');
const accounts = require('../lib/accounts');
const activity = require('../lib/activity');
const db = require('../lib/db');

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body || {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!guardApi(req, res, { name: 'admin-users', limit: 60, windowMs: 60000 })) return;

  const body = readBody(req);
  const action = String(body.action || 'list');

  try {
    // Public, non-sensitive capability probe for the installer UI.
    if (action === 'bootstrap-status') {
      return res.status(200).json({ ok: true, needsBootstrap: !accounts.hasAdmin() });
    }

    /* --- راه‌اندازی نخستین ادمین --- */
    if (action === 'bootstrap') {
      // Initial administrator provisioning requires an out-of-band secret.
      const expected = String(process.env.BILITFAST_ADMIN_BOOTSTRAP_SECRET || '');
      const provided = String(body.bootstrap_secret || (req.headers && req.headers['x-bootstrap-secret']) || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (expected.length < 32 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(403).json({ ok: false, error: 'راز راه‌اندازی مدیر معتبر نیست.' });
        return;
      }
      if (accounts.hasAdmin()) {
        res.status(403).json({ ok: false, error: 'ادمین از قبل وجود دارد. این مسیر بسته است.' });
        return;
      }
      const r = registerUser(body.username, body.password);
      if (!r.ok) { res.status(200).json(r); return; }
      db.update('users', r.user.id, {
        role: 'admin',
        is_active: true,
        display_name: String(body.display_name || 'مدیر سیستم').slice(0, 120),
        updated_at: new Date().toISOString(),
      });
      activity.log({ userId: r.user.id, type: 'ADMIN_BOOTSTRAP', req });
      res.status(200).json({ ok: true, token: r.token, user: accounts.adminView(db.findById('users', r.user.id)) });
      return;
    }

    /* --- بقیه اقدام‌ها: فقط ادمین --- */
    const gate = requireAdmin(req, res, body);
    if (!gate.ok) return;
    const admin = gate.user;

    if (action === 'list') {
      res.status(200).json({ ok: true, users: accounts.listUsers() });
      return;
    }

    if (action === 'create') {
      const password = String(body.password || '') || accounts.generatePassword();
      if (!validateUsername(body.username)) {
        res.status(200).json({ ok: false, error: 'نام کاربری نامعتبر است (۳ تا ۶۴ کاراکتر انگلیسی).' });
        return;
      }
      const r = registerUser(body.username, password);
      if (!r.ok) { res.status(200).json(r); return; }

      const patch = {};
      if (body.role !== undefined) patch.role = body.role;
      if (body.display_name !== undefined) patch.display_name = body.display_name;
      if (body.expires_at !== undefined) patch.expires_at = body.expires_at;
      if (body.max_searches !== undefined) patch.max_searches = body.max_searches;
      if (body.max_reservations !== undefined) patch.max_reservations = body.max_reservations;
      const applied = accounts.applyAdminPatch(r.user.id, patch);
      if (!applied.ok) { res.status(200).json(applied); return; }

      activity.log({ userId: admin.id, type: 'USER_CREATED', meta: { target: r.user.username }, req });
      // گذرواژه فقط همین یک بار برگردانده می‌شود تا ادمین بتواند به کاربر تستی بدهد.
      res.status(200).json({
        ok: true,
        user: applied.user,
        password,
        note: 'این گذرواژه فقط همین یک‌بار نمایش داده می‌شود. آن را ذخیره کنید.',
      });
      return;
    }

    if (action === 'update') {
      const target = db.findById('users', String(body.id || ''));
      if (!target) { res.status(200).json({ ok: false, error: 'کاربر پیدا نشد.' }); return; }

      /* محافظت از خودزنی: ادمین نباید آخرین ادمین فعال را از نقش بیندازد یا
       * غیرفعال کند، وگرنه سیستم بدون مدیر می‌ماند و قفل می‌شود. */
      const losingAdmin = (body.role !== undefined && body.role !== 'admin') || body.is_active === false;
      if (target.role === 'admin' && losingAdmin && accounts.countAdmins() <= 1) {
        res.status(200).json({ ok: false, error: 'این تنها ادمین فعال سیستم است و نمی‌توان دسترسی‌اش را گرفت.' });
        return;
      }

      const r = accounts.applyAdminPatch(target.id, body);
      if (r.ok) activity.log({ userId: admin.id, type: 'USER_UPDATED', meta: { target: target.username }, req });
      res.status(200).json(r);
      return;
    }

    if (action === 'reset-password') {
      const target = db.findById('users', String(body.id || ''));
      if (!target) { res.status(200).json({ ok: false, error: 'کاربر پیدا نشد.' }); return; }
      const password = String(body.password || '') || accounts.generatePassword();
      if (password.length < 6) {
        res.status(200).json({ ok: false, error: 'گذرواژه باید حداقل ۶ کاراکتر باشد.' });
        return;
      }
      db.update('users', target.id, { pass: hashPassword(password), updated_at: new Date().toISOString() });
      accounts.revokeSessions(target.id); // نشست‌های باز باید بسته شوند
      activity.log({ userId: admin.id, type: 'PASSWORD_RESET', meta: { target: target.username }, req });
      res.status(200).json({ ok: true, password, note: 'نشست‌های باز این کاربر بسته شد.' });
      return;
    }

    if (action === 'delete') {
      const target = db.findById('users', String(body.id || ''));
      if (!target) { res.status(200).json({ ok: false, error: 'کاربر پیدا نشد.' }); return; }
      if (target.id === admin.id) {
        res.status(200).json({ ok: false, error: 'نمی‌توانید حساب خودتان را حذف کنید.' });
        return;
      }
      if (target.role === 'admin' && accounts.countAdmins() <= 1) {
        res.status(200).json({ ok: false, error: 'این تنها ادمین فعال سیستم است و حذف نمی‌شود.' });
        return;
      }
      db.remove('users', target.id);
      activity.log({ userId: admin.id, type: 'USER_DELETED', meta: { target: target.username }, req });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'activity') {
      res.status(200).json({ ok: true, events: activity.list({ userId: body.user_id || null, limit: body.limit || 200 }) });
      return;
    }

    res.status(400).json({ ok: false, error: 'اقدام ناشناخته.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'خطای داخلی در مدیریت کاربران.' });
  }
};
