// options.js — ذخیره/بازیابی آدرس برنامه
const DEFAULT_APP_URL = 'http://localhost:3000';

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await chrome.storage.local.get({ appUrl: DEFAULT_APP_URL });
  document.getElementById('appUrl').value = cfg.appUrl;
});

document.getElementById('save').addEventListener('click', async () => {
  const appUrl = document.getElementById('appUrl').value.trim() || DEFAULT_APP_URL;
  await chrome.storage.local.set({ appUrl });
  const msg = document.getElementById('msg');
  msg.textContent = '✓ ذخیره شد';
  setTimeout(() => { msg.textContent = ''; }, 1500);
});
