import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assertHostTarget, assertRelativeSymlinks, copyApplication, linuxDesktopWriter, linuxLauncher, packageLayout, parsePackageOptions } from '../scripts/package-layout.mjs';

test('packaging refuses foreign Electron targets rather than claiming cross compilation', () => {
  for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['x64', 'arm64']) assert.doesNotThrow(() => assertHostTarget(platform, arch, platform, arch));
  assert.throws(() => assertHostTarget('win32', 'x64', 'linux', 'x64'), /仅支持本机/);
  assert.throws(() => assertHostTarget('darwin', 'arm64', 'darwin', 'x64'), /仅支持本机/);
  assert.throws(() => assertHostTarget('linux', 'ia32', 'linux', 'ia32'), /支持的架构/);
  assert.throws(() => parsePackageOptions(['--arch']), /需要参数/);
  assert.throws(() => parsePackageOptions(['--platfrom=linux']), /未知参数/);
  assert.throws(() => parsePackageOptions(['--layout-only']), /未知参数/);
  assert.equal(parsePackageOptions(['--layout-only'], true).layoutOnly, true);
});

test('native package locations retain macOS bundle and identify portable Windows/Linux launchers', () => {
  const mac = packageLayout('/example', 'darwin', 'arm64');
  assert.equal(mac.name, '映流 Studio.app');
  assert.equal(mac.executableRelative, 'Contents/MacOS/Electron');
  assert.equal(mac.appRelative, 'Contents/Resources/app');
  const windows = packageLayout('/example', 'win32', 'x64');
  assert.equal(windows.executableRelative, 'yingliu-studio.exe');
  assert.equal(windows.appRelative, 'resources/app');
  assert.equal(windows.name, 'yingliu-studio-win32-x64');
  const linux = packageLayout('/example', 'linux', 'arm64');
  assert.equal(linux.launcherRelative, 'yingliu-studio.sh');
  assert.equal(linux.executableRelative, 'yingliu-studio');
  assert.equal(linux.name, 'yingliu-studio-linux-arm64');
});

test('application copy includes runtime dependencies and licenses while omitting workspace data and development modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-package-test-'));
  try {
    const source = join(directory, 'source'), destination = join(directory, 'relocated', 'app');
    for (const path of ['dist/desktop', 'dist/ui', 'licenses', 'node_modules/playwright-core', 'node_modules/fflate', 'node_modules/tsx', '.local', 'projects']) await mkdir(join(source, path), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'test-app', productName: '测试应用', version: '1.2.3', main: 'dist/desktop/main.cjs', license: 'MIT', devDependencies: { tsx: 'secret' } }));
    for (const file of ['dist/desktop/main.cjs', 'dist/desktop/preload.cjs', 'dist/ui/app.js', 'licenses/MIT.txt', 'node_modules/playwright-core/LICENSE', 'node_modules/fflate/LICENSE', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.env', 'credentials.encrypted.json', '.local/provider.json', 'projects/private.json', 'node_modules/tsx/index.js']) await writeFile(join(source, file), file);
    await copyApplication(source, destination);
    assert.deepEqual((await readdir(destination)).sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist', 'licenses', 'node_modules', 'package.json']);
    assert.deepEqual((await readdir(join(destination, 'node_modules'))).sort(), ['fflate', 'playwright-core']);
    assert.equal(await readFile(join(destination, 'dist/desktop/main.cjs'), 'utf8'), 'dist/desktop/main.cjs');
    assert.equal(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).devDependencies, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('relative symlinks survive relocation and absolute or escaping links are rejected', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-symlink-test-'));
  try {
    const source = join(directory, 'source'), relocated = join(directory, 'relocated');
    await mkdir(join(source, 'Framework/Versions/A'), { recursive: true });
    await writeFile(join(source, 'Framework/Versions/A/runtime'), 'framework');
    await symlink('A', join(source, 'Framework/Versions/Current'));
    await symlink('Versions/Current/runtime', join(source, 'Framework/runtime'));
    await cp(source, relocated, { recursive: true, verbatimSymlinks: true });
    await rm(source, { recursive: true });
    await assertRelativeSymlinks(relocated);
    assert.equal(await readlink(join(relocated, 'Framework/runtime')), 'Versions/Current/runtime');
    assert.equal(await readFile(join(relocated, 'Framework/runtime'), 'utf8'), 'framework');
    await writeFile(join(directory, 'outside'), 'external');
    await symlink('../outside', join(relocated, 'escaping'));
    await assert.rejects(assertRelativeSymlinks(relocated), /必须相对且留在包内/);
    await rm(join(relocated, 'escaping'));
    await symlink(join(directory, 'outside'), join(relocated, 'absolute'));
    await assert.rejects(assertRelativeSymlinks(relocated), /必须相对且留在包内/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('portable Linux launcher resolves its moved folder and preserves caller arguments and cwd', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-launcher-test-'));
  try {
    const bundle = join(directory, '含 空格的目录'), unrelated = join(directory, 'caller');
    await mkdir(bundle); await mkdir(unrelated);
    const launcher = join(bundle, 'yingliu-studio.sh');
    await writeFile(launcher, linuxLauncher, { mode: 0o755 });
    await writeFile(join(bundle, 'yingliu-studio'), '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "${ELECTRON_RUN_AS_NODE-unset}" "$@"\n', { mode: 0o755 });
    const result = spawnSync(launcher, ['--flag', '中文 argument with spaces'], { cwd: unrelated, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [unrelated, 'unset', '--flag', '中文 argument with spaces']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('optional desktop entry honors isolated user menu and updates its installation path after moving the bundle', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-menu-test-'));
  try {
    const menu = join(directory, 'isolated-menu');
    const initial = join(directory, '中文 "quoted" $cash `tick` %percent'), moved = join(directory, 'moved bundle');
    await mkdir(initial); await mkdir(moved);
    for (const bundle of [initial, moved]) await writeFile(join(bundle, 'install-desktop-entry.cjs'), linuxDesktopWriter);
    const install = (bundle: string) => spawnSync(process.execPath, [join(bundle, 'install-desktop-entry.cjs')], { env: { ...process.env, XDG_DATA_HOME: menu }, encoding: 'utf8' });
    const first = install(initial); assert.equal(first.status, 0, first.stderr);
    const file = join(menu, 'applications/local.yingliu.studio.desktop');
    const firstEntry = await readFile(file, 'utf8');
    assert.ok(firstEntry.startsWith('[Desktop Entry]\n')); assert.ok(firstEntry.includes('%%percent')); assert.ok(firstEntry.includes('Terminal=false\n'));
    const second = install(moved); assert.equal(second.status, 0, second.stderr);
    const secondEntry = await readFile(file, 'utf8');
    assert.ok(secondEntry.includes(join(moved, 'yingliu-studio.sh'))); assert.ok(!secondEntry.includes('%%percent'));
    assert.deepEqual(await readdir(menu), ['applications']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
