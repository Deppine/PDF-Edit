// Copies the web app (the folder that contains this "desktop-app" folder) into ./web
// so Electron can package it. Run automatically by `npm start` / `npm run dist`.
const fs = require('fs');
const path = require('path');

const SRC = process.env.LYRA_WEB_DIR ? path.resolve(process.env.LYRA_WEB_DIR) : path.resolve(__dirname, '..', '..');
const DEST = path.resolve(__dirname, '..', 'web');
const FILES = ['index.html', 'script.js', 'style.css', 'theme-init.js'];
const DIRS = ['vendor'];

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('ไม่พบ index.html ใน ' + SRC + '\nวางโฟลเดอร์ desktop-app ไว้ข้างใน โฟลเดอร์ PDF EDIT (ที่มี index.html)');
  process.exit(1);
}
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
for (const d of DIRS) fs.cpSync(path.join(SRC, d), path.join(DEST, d), { recursive: true });
const n = (function count(p){ return fs.readdirSync(p, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? count(path.join(p, e.name)) : 1), 0); })(DEST);
console.log('sync-web: คัดลอก ' + n + ' ไฟล์จาก ' + SRC + ' -> ' + DEST);
