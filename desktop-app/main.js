// Lyra Desktop — Electron wrapper around the Lyra web app.
// The app is 100% client-side, so the wrapper only has to (1) serve the bundled files
// from a private custom protocol and (2) behave like a normal desktop program.
const { app, BrowserWindow, Menu, protocol, net, shell, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// A real origin (not file://) so web workers, fetch() of the OCR data and WebAssembly all work.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lyra', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const WEB_DIR = process.env.LYRA_WEB_DIR
  ? path.resolve(process.env.LYRA_WEB_DIR)
  : app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, 'web');

const START_URL = 'lyra://app/index.html';
let mainWindow = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function registerAppProtocol() {
  protocol.handle('lyra', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(WEB_DIR, rel));
    // never serve anything outside the bundled web folder
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function buildMenu() {
  const template = [
    { label: 'ไฟล์', submenu: [{ role: 'quit', label: 'ออกจากโปรแกรม' }] },
    {
      label: 'มุมมอง',
      submenu: [
        { role: 'reload', label: 'โหลดหน้าใหม่' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'ซูมเข้า' },
        { role: 'zoomOut', label: 'ซูมออก' },
        { role: 'resetZoom', label: 'ขนาดปกติ' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'เต็มหน้าจอ' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Lyra',
    backgroundColor: '#f4f5fb',
    autoHideMenuBar: true, // press Alt to show the menu
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // links that leave the app open in the normal browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // dropping a file outside a drop zone must not navigate the window to that file
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('lyra://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.on('page-title-updated', (e) => e.preventDefault()); // keep the title "Lyra"
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(START_URL);
}

app.whenReady().then(() => {
  // the app needs no camera/mic/location/etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerAppProtocol();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
