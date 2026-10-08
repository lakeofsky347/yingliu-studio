import { cp, mkdir, writeFile, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertHostTarget, assertRelativeSymlinks, copyApplication, electronRuntime, linuxDesktopInstaller, linuxDesktopWriter, linuxLauncher, packageLayout, parsePackageOptions } from './package-layout.mjs';

const options = parsePackageOptions(process.argv.slice(2));
if (options.help) {
  console.log('node scripts/package-app.mjs [--platform darwin|win32|linux] [--arch x64|arm64]\n仅使用本机安装的 Electron；不执行跨平台编译。');
  process.exit(0);
}
const require = createRequire(import.meta.url), root = resolve('.');
const layout = packageLayout(root, options.platform, options.arch);
const executable = require('electron');
const runtime = electronRuntime(executable);
assertHostTarget(runtime.platform, runtime.arch, options.platform, options.arch);
if (!runtime.electron) throw new Error('依赖未提供有效的 Electron runtime');
const source = options.platform === 'darwin' ? resolve(executable, '../../..') : dirname(executable);
const destination = layout.destination;
await mkdir(dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
if (options.platform === 'darwin') {
  for (const file of ['LICENSE', 'LICENSES.chromium.html']) await cp(join(dirname(source), file), join(destination, 'Contents/Resources', file));
}
const appRoot = join(destination, layout.appRelative);
// The stock Electron demo archive is unnecessary once resources/app is present.
await rm(join(destination, options.platform === 'darwin' ? 'Contents/Resources/default_app.asar' : 'resources/default_app.asar'), { force: true });
const packageInfo = await copyApplication(root, appRoot);
if (options.platform !== 'darwin') await rename(join(destination, layout.electronExecutable), join(destination, layout.executableRelative));
if (options.platform === 'linux') {
  for (const [name, contents] of [['yingliu-studio.sh', linuxLauncher], ['install-desktop-entry.sh', linuxDesktopInstaller]]) {
    await writeFile(join(destination, name), contents);
    await chmod(join(destination, name), 0o755);
  }
  await writeFile(join(destination, 'install-desktop-entry.cjs'), linuxDesktopWriter);
}
const distribution = options.platform === 'darwin' ? '本机 ad-hoc 临时签名；未公证' : 'portable 目录；未签名；未制作安装器';
await writeFile(join(destination, layout.manifestRelative), JSON.stringify({
  schemaVersion: 1, platform: options.platform, arch: options.arch, version: packageInfo.version,
  electronVersion: runtime.electron, appRelative: layout.appRelative, executableRelative: layout.executableRelative,
  launcherRelative: layout.launcherRelative, distribution, externalTools: ['Chrome/Chromium', 'FFmpeg', 'ffprobe'],
}, null, 2) + '\n');
await assertRelativeSymlinks(destination);
if (options.platform === 'darwin') {
  const plist = join(destination, 'Contents/Info.plist');
  let text = await readFile(plist, 'utf8');
  text = text.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1映流 Studio$2')
    .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, '$1local.yingliu.studio$2')
    .replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/, (_, start, end) => start + packageInfo.version + end)
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/, (_, start, end) => start + packageInfo.version + end);
  await writeFile(plist, text);
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', destination], { encoding: 'utf8' });
  if (signed.error || signed.status !== 0) throw new Error(signed.error?.message ?? signed.stderr);
}
console.log(`独立应用 ${options.platform}/${options.arch}：${destination}（${distribution}；Chrome/FFmpeg 从运行环境检测）`);
