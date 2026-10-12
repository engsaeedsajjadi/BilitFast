# BilitFast commercial hardening — 12 October 2026

This change is a security-focused patch on top of arena/01a07696-bilitfast.
It does not change the external ticket seller's service or claim live booking success.

## Implemented
- Removed the shared fixed activation secret; an operator-provisioned environment secret is now required.
- Production always enables strict security checks, multiuser authentication and license enforcement.
- Protected first-administrator setup with an out-of-band secret and a one-time capability probe.
- Local dev HTTP server now binds to loopback by default.
- Configuration of Telegram/Bale/Eitaa webhooks now requires admin authorization.
- Restricted outgoing payment links to HTTPS on Safir Rail or explicitly configured payment gateway hosts.
- Payment reports from the browser now remain unverified (payment_reported), not bank-confirmed.
- Removed tracked data/db.json from this branch and added gitignore exclusions.
- Desktop launcher now creates stable per-install keys in Electron userData instead of mismatched process-local keys.
- Added commercial-hardening regression coverage and GitHub Actions CI.

## Operator configuration
Set strong unique BILITFAST_SESSION_KEY, BILITFAST_LICENSE_KEY, BILITFAST_TOKEN_KEY,
BILITFAST_ACTIVATION_CODE and BILITFAST_ADMIN_BOOTSTRAP_SECRET.
After creating the first administrator, delete the bootstrap secret and restart.
Configure BILITFAST_PAYMENT_ALLOWED_HOSTS with the genuine HTTPS payment gateway hostnames.
Never ship .env or any secrets inside distributable packages.

## Remaining release blockers
- No validated end-to-end live ticket booking and payment confirmation.
- A client-reported paid flag is NOT confirmation of settlement or ticket issuance.
- The removed database may still be accessible in earlier Git commits; review contents,
  revoke exposed sessions, rotate credentials, and consider repository history cleanup.
- Electron-local keys are accessible to an administrator of the device and must not be
  mistaken for remotely enforceable DRM. For commercial sales, use online license activation
  and revocation, and provide a clearly documented offline grace policy.
- Existing desktop installations made using volatile install-signing keys may need an
  explicit migration strategy; past signatures cannot be verified without the lost key.
- Review legal/contractual permission for automated interaction with the seller.
- Update OCR benchmarks with real, held-out samples. The documented exact-match score is
  inadequate for relying exclusively on automatic CAPTCHA recognition.
- Test installer packaging, browser-session recovery, and Windows firewall/network rules.

## Checks
Run `npm ci`, `npm test`, `npm run audit:security` and the actual Windows installer smoke test.
CI runs unit/security tests, not live bank or ticket reservation requests.
