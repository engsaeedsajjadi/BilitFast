# BilitFast 3.5.0 — ARCaptcha first-party security review

## Chosen architecture: Path A (same tab + side panel)

- A user gesture in the extension starts the first-party reservation request. The browser navigates **the same tab** to `https://safirrail.ir`, leaving BilitFast visible in the Chrome/Edge side panel.
- The real official ARCaptcha remains in the SafirRail DOM and validates with SafirRail/ARCaptcha servers. BilitFast neither embeds nor clones it on the customer's domain.
- **Unverified** means the official challenge is displayed; the user must check it and press SafirRail's official confirmation button. We do not read/inspect `arcaptcha-token`, checkbox state, or challenge internals. **Human-verified** means SafirRail has advanced to its official passenger form; it is not independent proof of anti-bot validation.
- BilitFast's small first-party helper fills passenger fields **only on a separate user click**. It does not submit the CAPTCHA form or passenger form, and it does not redirect to a bank. The user verifies passengers, fare and route and manually presses the official site's confirmation control.
- The side panel reports: `unverified`, `human-verified`, `official-form-not-submitted`, `network-session-error`, and `return-to-official-page`, plus purchase review and the official payment-page transition.

## Files reviewed

`extension/popup.js`, `popup.html`, `background.js`, `checkout-flow.js`, `safir-passenger-helper.js`, `official-handoff.js`, `workspace.js`, `workspace.html`, `manifest.json`, `session-cookies.js`, and `public/route.html`. References: `INTEGRATED-ARCAPTCHA-WORKSPACE-FA.md`, `WEB-ARCAPTCHA-FIRST-PARTY-FA.md`, `SINGLE-TAB-FIRST-PARTY-CAPTCHA-FA.md`, `WEB-EXTENSION-FIX-2026-10-14-FA.md`, `SELFHOST-WEB-SELLER-FA.md`.

## Security invariants and tests

- No CAPTCHA solving, widget event synthesis, token reading/replay/forgery or cross-origin widget injection.
- Official forms must not be submitted automatically **after the ARCaptcha page is reached**. The initial first-party reservation POST is only performed after the user explicitly presses *Start reservation* in the extension.
- Passenger data lives only in temporary `chrome.storage.session`, tied to the original tab ID and expiring after 15 minutes; it is released only to the selected official tab. No values appear in side-panel messages.
- Navigation away from the official origin gives `return-to-official-page`; an expired/failed first-party handoff gives `network-session-error`.
- Run `npm run test:official-handoff` to cover unverified challenge, manual form fill, rejection of programmatic CAPTCHA and form submissions, official destination, tab isolation and status.

## Remaining limitations / required authorization

1. The real ARCaptcha cannot be displayed in BilitFast's DOM without SafirRail/ARCaptcha authorization for the site key/domain; iframe restrictions (`CSP frame-ancestors`, `X-Frame-Options`) must be honored. Offline verification without the official domain is unavailable.
2. Live challenge completion and reservation acceptance depend on SafirRail's origin, cookies, browser profile, and server-side logic. Only a test with an authorized live account can establish the full journey.
3. The existing legacy `popup.js` cookie-transfer feature is **separate** from the first-party CAPTCHA path. Sending session cookies to an agency server poses a material security risk; prefer direct first-party browser operations. Review/decommission the legacy transfer before commercial release and document consent and retention requirements.
4. A web-only installation requires the customer-controlled HTTPS host; it is not a serverless offline application. Multi-user scale needs transactional storage rather than the current JSON file.
5. The extension is unpacked and not yet validated in Chrome/Edge extension stores. A real-browser smoke test is still required. No live ticketing or banking test was performed here.
