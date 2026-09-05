#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'desktop');
const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
const platform = args.includes('--platform') ? flag('--platform') : process.platform;
const runtime = args.includes('--runtime') ? path.resolve(flag('--runtime')) : process.execPath;
const release = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8'));
const legalFiles = ['LICENSE', 'NOTICE', 'ADDITIONAL_TERMS.md', 'TRADEMARKS.md', 'PRIVACY.md'];
async function copyApp(destination) {
  await fs.mkdir(path.join(destination, 'desktop'), { recursive: true });
  for (const name of ['index.html', 'sync-client.js', 'release.json', 'README.md', 'SYNC_DESIGN.md', ...legalFiles]) await fs.copyFile(path.join(root, name), path.join(destination, name));
  await fs.cp(path.join(root, 'vendor'), path.join(destination, 'vendor'), { recursive: true });
  // Include the editable host and launcher sources with the distribution.
  for (const name of ['server.mjs', 'build.mjs', 'launcher-windows.c']) await fs.copyFile(path.join(root, 'desktop', name), path.join(destination, 'desktop', name));
}
await fs.mkdir(output, { recursive: true });
const license = path.join(output, 'runtime', 'Node-LICENSE.txt');
await fs.access(license);
if (platform === 'darwin') {
  const app = path.join(output, 'VictoryPVI.app');
  await fs.rm(app, { recursive: true, force: true });
  const contents = path.join(app, 'Contents'), resources = path.join(contents, 'Resources');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(resources, 'runtime'), { recursive: true });
  await copyApp(path.join(resources, 'app'));
  await fs.copyFile(runtime, path.join(resources, 'runtime', 'node'));
  await fs.chmod(path.join(resources, 'runtime', 'node'), 0o755);
  await fs.copyFile(license, path.join(resources, 'runtime', 'LICENSE.txt'));
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>VictoryPVI</string>
<key>CFBundleDisplayName</key><string>VictoryPVI</string>
<key>CFBundleIdentifier</key><string>community.victorypvi.desktop</string>
<key>CFBundleVersion</key><string>${release.version}</string>
<key>CFBundleShortVersionString</key><string>${release.version}</string>
<key>CFBundleExecutable</key><string>VictoryPVI</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSUIElement</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>让同一网络中的手机和平板显示电脑上的记录。</string>
</dict></plist>`);
  await fs.writeFile(path.join(contents, 'MacOS', 'VictoryPVI'), `#!/bin/sh
VPVI_RESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
"$VPVI_RESOURCES/runtime/node" "$VPVI_RESOURCES/app/desktop/server.mjs" --open
VPVI_RESULT=$?
if [ "$VPVI_RESULT" -ne 0 ]; then
  /usr/bin/osascript -e 'display dialog "客户端未能启动。详细原因保存在个人资源库 Application Support/VictoryPVI/startup-error.txt。" with title "VictoryPVI" buttons {"好"} default button "好"'
fi
exit "$VPVI_RESULT"
`);
  await fs.chmod(path.join(contents, 'MacOS', 'VictoryPVI'), 0o755);
  // Local ad-hoc signature permits intact Apple Silicon execution; distribution is not notarized.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  const zip = path.join(output, 'VictoryPVI-macOS.zip');
  await fs.rm(zip, { force: true });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  console.log(zip);
} else if (platform === 'win32') {
  const dir = path.join(output, 'VictoryPVI-Windows');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'runtime'), { recursive: true });
  await copyApp(path.join(dir, 'app'));
  await fs.copyFile(runtime, path.join(dir, 'runtime', 'node.exe'));
  await fs.copyFile(license, path.join(dir, 'runtime', 'LICENSE.txt'));
  const compiler = process.env.VICTORYPVI_CC || (process.platform === 'win32' ? 'gcc' : 'x86_64-w64-mingw32-gcc');
  execFileSync(compiler, ['-municode', '-mwindows', '-Os', '-static', '-s', path.join(root, 'desktop', 'launcher-windows.c'), '-o', path.join(dir, 'VictoryPVI.exe')], { stdio: 'inherit' });
  await fs.writeFile(path.join(dir, '使用说明.txt'), '\ufeff完整解压后双击 VictoryPVI.exe。\r\n首次使用请允许通过防火墙；手机与电脑连接同一 Wi-Fi / 热点。\r\n平时从网页进入，需要同步时下载并打开客户端，回网页点“已启动，连接并继续记录”。\r\n退出：在电脑网页的“多端同步”中点“退出电脑客户端”。\r\n系统要求：Windows 10 / 11，64 位。\r\n记录保存在 %LOCALAPPDATA%\\VictoryPVI，不在此文件夹中。\r\n');
  const zip = path.join(output, 'VictoryPVI-Windows-x64.zip');
  await fs.rm(zip, { force: true });
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${dir.replaceAll("'", "''")}' -DestinationPath '${zip.replaceAll("'", "''")}'`]);
  else execFileSync('zip', ['-qr', zip, 'VictoryPVI-Windows'], { cwd: output });
  console.log(zip);
} else throw new Error('Use --platform darwin or win32');
