import { cp, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const platforms = new Set(['darwin', 'win32', 'linux']);
const architectures = new Set(['x64', 'arm64']);

/** Select only the installed host runtime; this script does not cross-compile Electron. */
export function assertHostTarget(platform, arch, hostPlatform = process.platform, hostArch = process.arch) {
  if (!platforms.has(platform)) throw new Error('支持的平台为 darwin、win32、linux');
  if (!architectures.has(arch)) throw new Error('支持的架构为 x64、arm64');
  if (platform !== hostPlatform || arch !== hostArch) {
    throw new Error(`仅支持本机打包/验证：当前 ${hostPlatform}/${hostArch}，请求 ${platform}/${arch}。请在目标系统上安装依赖并执行。`);
  }
}

export function parsePackageOptions(args, allowVerification = false) {
  const options = { platform: process.platform, arch: process.arch, layoutOnly: false, bundle: undefined, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') { options.help = true; continue; }
    if (allowVerification && argument === '--layout-only') { options.layoutOnly = true; continue; }
    const [flag, inline] = argument.split(/=(.*)/s, 2);
    if (!['--platform', '--arch', ...(allowVerification ? ['--bundle'] : [])].includes(flag)) throw new Error('未知参数：' + argument);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(flag + ' 需要参数');
    options[flag.slice(2)] = value;
  }
  assertHostTarget(options.platform, options.arch);
  return options;
}

export function packageLayout(root, platform = process.platform, arch = process.arch) {
  if (!platforms.has(platform) || !architectures.has(arch)) throw new Error('不支持此平台或架构');
  const mac = platform === 'darwin';
  const name = mac ? '映流 Studio.app' : `yingliu-studio-${platform}-${arch}`;
  const executableRelative = mac ? 'Contents/MacOS/Electron' : platform === 'win32' ? 'yingliu-studio.exe' : 'yingliu-studio';
  const appRelative = mac ? 'Contents/Resources/app' : 'resources/app';
  return {
    name, platform, arch, destination: join(root, 'artifacts', name), appRelative, executableRelative,
    launcherRelative: platform === 'linux' ? 'yingliu-studio.sh' : executableRelative,
    manifestRelative: mac ? 'Contents/Resources/yingliu-package.json' : 'yingliu-package.json',
    electronExecutable: mac ? 'Electron.app/Contents/MacOS/Electron' : platform === 'win32' ? 'electron.exe' : 'electron',
  };
}

export function probeElectron(executable, script, args = []) {
  const result = spawnSync(executable, [script, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`Electron Node 模式执行失败：${result.error?.message ?? result.stderr.trim() ?? result.status}`);
  return result.stdout.trim();
}

export function electronRuntime(executable) {
  return JSON.parse(probeElectron(executable, '-p', ['JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron})']));
}

/** Copy the explicit application allowlist, never the workspace or its user data. */
export async function copyApplication(root, appRoot) {
  await mkdir(join(appRoot, 'node_modules'), { recursive: true });
  for (const directory of ['dist', 'licenses']) await cp(join(root, directory), join(appRoot, directory), { recursive: true, verbatimSymlinks: true });
  for (const dependency of ['playwright-core', 'fflate']) await cp(join(root, 'node_modules', dependency), join(appRoot, 'node_modules', dependency), { recursive: true, verbatimSymlinks: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, file), join(appRoot, file));
  const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: info.name, productName: info.productName, version: info.version, main: info.main, license: info.license }, null, 2) + '\n');
  return info;
}

export async function assertRelativeSymlinks(directory) {
  const base = await realpath(directory);
  const inside = path => { const local = relative(base, path); return local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local); };
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(file);
        if (isAbsolute(target) || !inside(resolve(dirname(file), target)) || !inside(await realpath(file))) throw new Error('应用包软链接必须相对且留在包内：' + file);
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(base);
}

export const linuxLauncher = `#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset ELECTRON_RUN_AS_NODE
exec "$APP_DIR/yingliu-studio" "$@"
`;

// Desktop files bind to an installation path. Generate one only when the user
// explicitly runs this helper, and regenerate it after moving the portable folder.
export const linuxDesktopInstaller = `#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ELECTRON_RUN_AS_NODE=1 exec "$APP_DIR/yingliu-studio" "$APP_DIR/install-desktop-entry.cjs"
`;

export const linuxDesktopWriter = `const {mkdirSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {homedir}=require('node:os');
const directory=join(process.env.XDG_DATA_HOME||join(homedir(),'.local/share'),'applications');
// Desktop Entry quoting, then its generic value backslash escaping.
const executable=join(__dirname,'yingliu-studio.sh');
const quoted='"'+executable.replace(/["\x60$\\\\]/g,char=>'\\\\'+char).replace(/%/g,'%%')+'"';
const exec=quoted.replace(/\\\\/g,'\\\\\\\\');
mkdirSync(directory,{recursive:true});
const file=join(directory,'local.yingliu.studio.desktop');
writeFileSync(file,'[Desktop Entry]\\nType=Application\\nName=映流 Studio\\nComment=本地视频创作应用\\nExec='+exec+'\\nTerminal=false\\nCategories=AudioVideo;Video;\\n',{mode:0o644});
console.log('已安装桌面入口：'+file+'。移动应用目录后请重新运行安装脚本。');
`;
