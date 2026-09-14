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

/* حالت ابری: اگر API_BASE_URL تنظیم شده باشد، به‌جای بالا آوردن سرور داخلی،
 * پنجره مستقیماً به بک‌اند راه دور وصل می‌شود. کاربردش وقتی است که سرور روی
 * یک ماشین با دسترسی شبکه به صفیر ریل اجرا می‌شود و کاربر فقط کلاینت دارد.
 *
 * فقط https پذیرفته می‌شود (به‌جز localhost برای تست): توکن نشست روی این
 * اتصال رد و بدل می‌شود و http یعنی هر کسی در مسیر می‌تواند آن را بردارد. */
function remoteApiBase() {
  const raw = String(process.env.API_BASE_URL || readSetting('api_base_url') || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !isLocal) {
    console.error('API_BASE_URL باید https باشد؛ مقدار نامعتبر نادیده گرفته شد:', raw);
    return null;
  }
  return u.origin;
}

/** خواندن تنظیمات دسکتاپ از فایل settings.json در پوشه داده کاربر. */
function readSetting(key) {
  try {
    const fs = require('fs');
    const p = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(p)) return null;
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    return o && o[key] !== undefined ? o[key] : null;
  } catch (e) {
    return null;
  }
}

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
  const remote = remoteApiBase();
  win.loadURL(remote ? remote + '/' : 'http://127.0.0.1:' + PORT + '/');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // در حالت ابری سرور محلی لازم نیست؛ بالا آوردنش فقط منابع مصرف می‌کند.
  if (!remoteApiBase()) startServer();
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
