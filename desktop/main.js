// desktop/main.js — پوسته دسکتاپ (Electron).
// سرور Node داخل خود برنامه روی یک پورت محلی بالا می‌آید و پنجره برنامه
// همان را نشان می‌دهد؛ هیچ وابستگی‌ای به نصب Node روی سیستم کاربر نیست.
//
// محیط BILITFAST_DESKTOP=1 به صفحه وب گفته می‌شود که داخل exe اجرا می‌شود و
// باید اطلاعات نصب را از طریق window.bilitDesktop بخواند.

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');

// در توسعه: ریشه مخزن (desktop/..)؛ در نسخه بسته‌بندی‌شده: کد سرور به‌صورت
// extraResources کنار asar در resources/app قرار می‌گیرد.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : (process.env.BILITFAST_ROOT || path.join(__dirname, '..'));
process.env.BILITFAST_ROOT = ROOT;
const PORT = process.env.BILITFAST_DESKTOP_PORT || '3210';

let win = null;
let serverInfo = null;

function startServer() {
  if (serverInfo) return serverInfo;
  const fs = require('fs');
  const path = require('path');
  // داده برنامه (پایگاه‌داده حساب‌ها، کوکی‌ها) در پوشه ماندگار کاربر ذخیره می‌شود
  // تا با به‌روزرسانی/نصب مجددِ فایل‌های برنامه پاک نشود.
  const dataDir = path.join(app.getPath('userData'), 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* ignore */ }
  const env = {
    ...process.env,
    PORT,
    BILITFAST_DESKTOP: '1',
    BILITFAST_DESKTOP_PORT: PORT,
    BILITFAST_DATA_DIR: dataDir,
  };
  const { fork } = require('child_process');
  const child = fork(path.join(ROOT, 'dev-server.js'), [], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout && child.stdout.on('data', (d) => console.log('[server]', String(d).trim()));
  child.stderr && child.stderr.on('data', (d) => console.error('[server]', String(d).trim()));
  serverInfo = { child };
  return serverInfo;
}

function getInstallInfo() {
  try {
    // فقط روی ویندوز رجیستری نوشته/خوانده می‌شود
    if (process.platform === 'win32') {
      const { ensureInstallMarker } = require('./install');
      return ensureInstallMarker();
    }
    return { ok: false, reason: 'not-windows' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Bilit Fast',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('http://127.0.0.1:' + PORT + '/');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  startServer();
  ipcMain.handle('bilit:get-install-info', () => getInstallInfo());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverInfo && serverInfo.child) { try { serverInfo.child.kill(); } catch (e) { /* ignore */ } }
  if (process.platform !== 'darwin') app.quit();
});
