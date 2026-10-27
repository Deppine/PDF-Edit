// Builds the Windows app folder  out/Lyra-win32-x64/  (Lyra.exe + files) without any
// code-signing tools, so it works the same on Windows, macOS and Linux.
//   npm run pack
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const _pk = require('@electron/packager');
const packager = _pk.packager || _pk;
const pkg = require('../package.json');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  execFileSync(process.execPath, [path.join(__dirname, 'sync-web.js')], { stdio: 'inherit' });
  fs.rmSync(path.join(ROOT, 'out'), { recursive: true, force: true });

  const [appDir] = await packager({
    dir: ROOT,
    name: 'Lyra',
    executableName: 'Lyra',
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'out'),
    overwrite: true,
    prune: true,
    asar: true,
    appVersion: pkg.version,
    extraResource: [path.join(ROOT, 'web')],
    ignore: [/^\/(web|scripts|out|dist)($|\/)/, /^\/build\/icon\.ico$/, /^\/README/i, /^\/build-windows\.bat$/i],
  });

  // keep only English + Thai Chromium language packs (saves ~45 MB)
  const loc = path.join(appDir, 'locales');
  if (fs.existsSync(loc)) {
    for (const f of fs.readdirSync(loc)) if (!/^(en-US|th)\.pak$/.test(f)) fs.rmSync(path.join(loc, f));
  }
  execFileSync(process.execPath, [
    path.join(__dirname, 'set-exe-icon.js'), path.join(appDir, 'Lyra.exe'), path.join(ROOT, 'build', 'icon.ico'), pkg.version,
  ], { stdio: 'inherit' });

  console.log('\nเสร็จแล้ว: ' + appDir + '\nเปิดไฟล์ Lyra.exe ในโฟลเดอร์นั้น หรือคัดลอกทั้งโฟลเดอร์ไปไว้ที่โฟลเดอร์กลาง');
})().catch((e) => { console.error(e); process.exit(1); });
