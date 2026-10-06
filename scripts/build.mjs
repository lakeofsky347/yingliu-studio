import { build } from 'esbuild';
import { mkdir, rm, cp } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/ui', { recursive: true });
await build({ entryPoints: ['src/client/index.tsx'], bundle: true, format: 'esm', platform: 'browser', outfile: 'dist/ui/app.js', sourcemap: false, loader: { '.css': 'css' }, target: ['chrome120'], logLevel: 'info' });
await cp('public/index.html', 'dist/ui/index.html');
await build({ entryPoints: ['src/app/web-server.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/web-server.mjs', packages: 'external', target: 'node22', logLevel: 'info' });
await build({ entryPoints: ['src/desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/desktop/main.cjs', packages: 'external', target: 'node22', logLevel: 'info' });
await build({ entryPoints: ['src/desktop/preload.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/desktop/preload.cjs', external: ['electron'], target: 'node22', logLevel: 'info' });
