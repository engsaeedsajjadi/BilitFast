// -*- coding: utf-8 -*-
/**
 * lib/subscription.js — اشتراک و درگاه پرداخت (زرین‌پال).
 *
 * طرح‌ها از config.json → subscription.plans خوانده می‌شوند.
 * برای فعال‌شدن پرداخت واقعی، متغیر محیطی ZARINPAL_MERCHANT_ID لازم است؛
 * با ZARINPAL_MODE=sandbox می‌توان با مرچنت «test» روی سندباکس آزمایش کرد.
 *
 * واحد مبلغ به‌صورت پیش‌فرض ریال است (طبق مستندات زرین‌پال) و از
 * config.subscription.amount_unit قابل تغییر است.
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const db = require('./db');

const SUB = config.subscription || {};

function plans() {
  return Array.isArray(SUB.plans) ? SUB.plans : [];
}
function getPlan(planId) {
  return plans().find((p) => p.id === planId) || null;
}
function merchantId() {
  return (process.env.ZARINPAL_MERCHANT_ID || '').trim();
}
function isSandbox() {
  return String(process.env.ZARINPAL_MODE || '').toLowerCase() === 'sandbox';
}
function paymentConfigured() {
  return !!merchantId();
}

function zarinBase() {
  return isSandbox() ? 'https://sandbox.zarinpal.com/pg/v4/payment' : 'https://api.zarinpal.com/pg/v4/payment';
}
function startPayBase() {
  return isSandbox() ? 'https://sandbox.zarinpal.com/pg/StartPay/' : 'https://www.zarinpal.com/pg/StartPay/';
}

/** وضعیت اشتراک کاربر: طرح فعال یا هیچ. */
function activeSubscription(userId) {
  const subs = db.find('subscriptions', (s) => s.user_id === userId && s.status === 'active');
  return subs.find((s) => (s.expires_at || 0) > Date.now()) || null;
}

/** ساخت درخواست خرید؛ خروجی شامل آدرس هدایت به درگاه است. */
async function createCheckout(user, planId, callbackUrl) {
  const plan = getPlan(planId);
  if (!plan) return { ok: false, error: 'طرح انتخابی معتبر نیست.' };
  if (!paymentConfigured()) {
    return { ok: false, error: 'درگاه پرداخت روی این استقرار پیکربندی نشده است (ZARINPAL_MERCHANT_ID تنظیم نشده). برای فعال‌سازی با مدیریت تماس بگیرید یا پرداخت را به‌صورت دستی انجام دهید.' };
  }
  const amountUnit = SUB.amount_unit || 'rial';
  const amount = amountUnit === 'toman' ? Math.round(plan.price_rial / 10) : plan.price_rial;

  const sub = db.insert('subscriptions', {
    user_id: user.id,
    plan: plan.id,
    plan_title: plan.title,
    days: plan.days,
    amount,
    amount_unit: amountUnit,
    status: 'pending',
    authority: null,
    ref_id: null,
    expires_at: null,
  });

  try {
    const resp = await fetch(zarinBase() + '/request.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchant_id: merchantId(),
        amount,
        description: 'اشتراک بیلیت فست — ' + plan.title,
        callback_url: callbackUrl,
      }),
    });
    const data = await resp.json();
    if (data && data.data && data.data.code === 100 && data.data.authority) {
      db.update('subscriptions', sub.id, { authority: data.data.authority });
      return { ok: true, subscription_id: sub.id, authority: data.data.authority, redirectUrl: startPayBase() + data.data.authority };
    }
    db.update('subscriptions', sub.id, { status: 'failed', gateway_error: JSON.stringify(data).slice(0, 500) });
    return { ok: false, error: 'درگاه پرداخت خطا داد: ' + ((data && data.errors && data.errors.message) || JSON.stringify(data).slice(0, 200)) };
  } catch (e) {
    db.update('subscriptions', sub.id, { status: 'failed', gateway_error: String(e && e.message || e).slice(0, 300) });
    return { ok: false, error: 'خطا در ارتباط با درگاه پرداخت: ' + (e && e.message ? e.message : e) };
  }
}

/** تأیید پرداخت پس از بازگشت از درگاه. */
async function verifyCheckout(authority, amount, subscriptionId) {
  const sub = db.findById('subscriptions', subscriptionId) ||
    db.findOne('subscriptions', (s) => s.authority === authority && s.status === 'pending');
  if (!sub) return { ok: false, error: 'پرداخت مورد نظر یافت نشد.' };
  if (sub.status === 'active') return { ok: true, already: true, subscription: sub };

  try {
    const resp = await fetch(zarinBase() + '/verify.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchant_id: merchantId(), authority, amount: amount || sub.amount }),
    });
    const data = await resp.json();
    const code = data && data.data && data.data.code;
    if (code === 100 || code === 101) {
      // 100 موفق / 101 قبلاً تأیید شده
      const now = Date.now();
      // اگر کاربر از قبل اشتراک فعال دارد، به انتهای آن اضافه می‌شود
      const current = activeSubscription(sub.user_id);
      const base = current && current.expires_at > now ? current.expires_at : now;
      const expiresAt = base + (sub.days || 30) * 86400000;
      db.update('subscriptions', sub.id, { status: 'active', ref_id: (data.data && data.data.ref_id) || null, expires_at: expiresAt });
      return { ok: true, subscription: db.findById('subscriptions', sub.id), ref_id: data.data && data.data.ref_id };
    }
    db.update('subscriptions', sub.id, { status: 'failed', gateway_error: 'verify code ' + code });
    return { ok: false, error: 'پرداخت توسط درگاه تأیید نشد (کد ' + code + '). اگر مبلغی کسر شده، معمولاً تا ۷۲ ساعت خودکار برگشت می‌خورد.' };
  } catch (e) {
    return { ok: false, error: 'خطا در تأیید پرداخت: ' + (e && e.message ? e.message : e) };
  }
}

/** خلاصه وضعیت اشتراک برای نمایش. */
function subscriptionStatus(user) {
  const sub = user ? activeSubscription(user.id) : null;
  if (!sub) return { active: false, message: 'اشتراک فعال ندارید.' };
  const daysLeft = Math.max(0, Math.ceil(((sub.expires_at || 0) - Date.now()) / 86400000));
  return {
    active: true,
    plan: sub.plan,
    plan_title: sub.plan_title,
    expires_at: sub.expires_at,
    days_left: daysLeft,
    message: 'اشتراک «' + (sub.plan_title || sub.plan) + '» فعال است (' + daysLeft + ' روز باقی‌مانده).',
  };
}

module.exports = {
  plans, getPlan, merchantId, isSandbox, paymentConfigured,
  createCheckout, verifyCheckout, activeSubscription, subscriptionStatus,
};
