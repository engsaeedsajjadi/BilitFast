// desktop/preload.js — پل امن بین صفحه وب و پوسته دسکتاپ (contextBridge).
// فقط اطلاعات نصب (تاریخ نصب، شناسه دستگاه، امضا) در دسترس صفحه قرار می‌گیرد؛
// دسترسی مستقیم به Node از داخل صفحه وب ممکن نیست.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bilitDesktop', {
  isDesktop: true,
  getInstallInfo: () => ipcRenderer.invoke('bilit:get-install-info'),
});
