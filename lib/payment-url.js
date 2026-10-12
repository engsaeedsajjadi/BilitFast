// Validate payment URLs before storage or forwarding through messaging.
// External bank domains require explicit operator allowlisting.
function safePaymentUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.length > 1000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    const allowed = String(process.env.BILITFAST_PAYMENT_ALLOWED_HOSTS || '')
      .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    if (!(host === 'safirrail.ir' || host.endsWith('.safirrail.ir') || allowed.includes(host))) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}
module.exports = { safePaymentUrl };
