// Gives Lyra.exe its own icon + version info (done in pure JS so it also works from Linux/macOS).
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

const exePath = path.resolve(process.argv[2]);
const icoPath = path.resolve(process.argv[3]);
const version = process.argv[4] || '2.0.0';

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
const res = ResEdit.NtExecutableResource.from(exe);

const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const g = groups[0];
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries, g ? g.id : 1, g ? g.lang : 1033, iconFile.icons.map((i) => i.data));

const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (vis.length) {
  const vi = vis[0];
  const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10) || 0);
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'Lyra', FileDescription: 'Lyra - PDF Tools', CompanyName: 'ASCGroup',
    OriginalFilename: 'Lyra.exe', InternalName: 'Lyra', LegalCopyright: 'ASCGroup',
  });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('icon + version set on', exePath);
