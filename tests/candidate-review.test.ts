import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { compileSpec, createProject } from '../src/core/index.js';
import { ProjectStore } from '../src/host/store.js';
import { VideoRenderer, detectEnvironment } from '../src/host/renderer.js';
import type { SceneSource, StudioSnapshot, VideoSpec } from '../src/shared/types.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scene = (color: string): SceneSource => ({
  html: '', css: '',
  js: `export function render(ctx) { ctx.ctx2d.fillStyle = '${color}'; ctx.ctx2d.fillRect(0, 0, ctx.width, ctx.height); }`,
});

async function fileHashes(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      files[name + '/'] = 'directory';
      Object.assign(files, await fileHashes(root, name));
    } else files[name] = hash(await fs.readFile(path.join(root, name)));
  }
  return files;
}

const environment = detectEnvironment();

test('frame capture retries only temporary Chromium screenshot failures', async () => {
  const renderer = new VideoRenderer(), spec = compileSpec(createProject('重试测试'));
  type FramePage = { evaluate(): Promise<unknown>; screenshot(): Promise<Buffer> };
  const capture = Reflect.get(renderer, 'frame').bind(renderer) as (page:FramePage, spec:VideoSpec, frame:number) => Promise<{buffer:Buffer;shotId:string}>;
  let renders = 0, attempts = 0;
  const evaluate = async () => { renders++; return {ok:true, info:{sceneId:spec.shots[0]!.id}}; };
  const transient = new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
  const ok = await capture({ evaluate, async screenshot() {
    attempts++;
    if (attempts < 3) throw transient;
    return Buffer.from('capture');
  } }, spec, 0);
  assert.equal(ok.buffer.toString(),'capture');
  assert.equal(attempts,3);
  assert.equal(renders,3);
  attempts = 0;
  await assert.rejects(capture({ evaluate, async screenshot() { attempts++; throw transient; } }, spec, 0), transient);
  assert.equal(attempts,3);
  attempts = 0;
  const permanent = new Error('Target page was closed');
  await assert.rejects(capture({ evaluate, async screenshot() { attempts++; throw permanent; } }, spec, 0), permanent);
  assert.equal(attempts,1);
});

test('the desktop thumbnail endpoint returns saved, scaled frames and reuses individual cached images', {
  skip: !environment.browserAvailable,
  timeout: 60_000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-thumbnails-'));
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets() });
  try {
    const initial = createProject('分镜画面卡片');
    initial.shots = initial.shots.slice(0,1); initial.shotOrder = initial.shots.map(shot=>shot.id);
    initial.shots[0]!.durationFrames = 12;
    initial.target = { width: 640, height: 360, fps: { num: 12, den: 1 }, audioMode: 'none' };
    const created = await app.route('create', { project:initial, expectedRevision:null, operationId:'thumbnail-test-create', sources:[{ shotId:initial.shots[0]!.id, source:scene('#0000ff') }] });
    assert.ok(created.ok);
    const { project } = created.value as StudioSnapshot;
    const input = { projectId:project!.id, expectedRevision:project!.revision };
    const stale = await app.route('thumbnails', { ...input, expectedRevision:input.expectedRevision+1, frames:[6] });
    assert.ok(!stale.ok); assert.equal(stale.error.code,'REVISION_CONFLICT');
    for (const frames of [[], [0,1,2,3], [12], ['6']]) {
      const invalid = await app.route('thumbnails', { ...input, frames });
      assert.ok(!invalid.ok); assert.match(invalid.error.message,/有效帧号/);
    }
    const first = await app.route('thumbnails', { ...input, frames:[0,6] });
    assert.ok(first.ok, first.ok ? undefined : first.error.message);
    const result = first.value as { projectId:string; revision:number; frames:{frame:number;url:string}[] };
    assert.equal(result.projectId,input.projectId); assert.equal(result.revision,input.expectedRevision);
    assert.deepEqual(result.frames.map(item=>item.frame),[0,6]);
    const second = await app.route('thumbnails', { ...input, frames:[6] });
    assert.deepEqual(second,{ok:true,value:{...result,frames:[result.frames[1]!]}});
    const resource = await fetch(result.frames[1]!.url);
    assert.equal(resource.status,200); assert.equal(resource.headers.get('content-type'),'image/png');
    const png = Buffer.from(await resource.arrayBuffer());
    assert.equal(png.readUInt32BE(16),320); assert.equal(png.readUInt32BE(20),180);
  } finally {
    await app.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('real Chromium candidate capture changes pixels without mutating live head, sources or runtime', {
  skip: environment.browserAvailable ? false : 'Executable Chromium unavailable; candidate rendering isolation was not verified.',
  timeout: 60_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-candidate-review-'));
  const store = new ProjectStore({ baseDirectory: directory }), renderer = new VideoRenderer(store);
  const candidateDirectories: string[] = [];
  // Record real snapshot directories so cleanup assertions cannot race other test processes.
  const makeTemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args: Parameters<typeof fs.mkdtemp>) => {
    const result = await makeTemp(...args);
    if (String(args[0]).endsWith('video-studio-candidate-')) candidateDirectories.push(String(result));
    return result;
  });
  try {
    const initial = createProject('候选画面隔离');
    initial.shots = initial.shots.slice(0, 1); initial.shotOrder = initial.shots.map(shot => shot.id);
    initial.shots[0]!.durationFrames = 12;
    initial.target = { width: 160, height: 90, fps: { num: 12, den: 1 }, audioMode: 'none' }; initial.targetDuration = 1;
    const shot = initial.shots[0]!, blue = scene('#0000ff');
    const { root, project } = await store.create({ project: initial, sources: [{ shotId: shot.id, source: blue }] });
    const baseline = await renderer.capture(root, project, environment, 6);
    const baselineBytes = await fs.readFile(baseline.path), liveFiles = await fileHashes(root);
    for (const file of ['project.json', '.studio/state.json', shot.sourcePath + '/source.json']) {
      assert.ok(liveFiles[file], 'Baseline must include ' + file);
    }
    assert.ok(Object.keys(liveFiles).some(file=>/^runtime\/versions\/[a-f0-9]{64}\/runtime\/spec.json$/.test(file)));
    const originalProject = structuredClone(project);
    const candidate = await renderer.captureCandidate(root, project, { [shot.id]: scene('#ff0000') }, environment, 6);

    assert.equal(candidate.mime, 'image/png');
    assert.equal(candidate.sha256, hash(candidate.bytes));
    assert.equal(baseline.sha256, hash(baselineBytes));
    assert.notEqual(candidate.sha256, baseline.sha256, 'The candidate must render its red source instead of the committed blue source');
    assert.notDeepEqual(Buffer.from(candidate.bytes), baselineBytes);
    assert.deepEqual(await fileHashes(root), liveFiles, 'Candidate review must preserve all live files, including runtime and history');
    assert.deepEqual(project, originalProject);
    assert.deepEqual(await store.readSource(root, shot), blue);
    assert.equal(candidateDirectories.length, 1);
    await assert.rejects(fs.stat(candidateDirectories[0]!), { code: 'ENOENT' });
  } finally {
    await renderer.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('independent preview servers keep both committed versions addressable without overwriting runtime',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-version-preview-')),store=new ProjectStore({baseDirectory:directory}),first=new VideoRenderer(store),second=new VideoRenderer(store);
  try{
    const initial=createProject('并行版本预览'),shot=initial.shots[0]!;
    const {root,project}=await store.create({project:initial,sources:[{shotId:shot.id,source:scene('#0000ff')}]});
    const oldUrl=await first.preview(root,project),oldSource=new URL('./runtime/scenes/'+shot.id+'.mjs',oldUrl).href;
    const before=await (await fetch(oldSource)).text();
    const next=await store.commit(root,{...project,revision:1},{[shot.id]:scene('#ff0000')},{expectedRevision:0});
    const newUrl=await second.preview(root,next),newSource=new URL('./runtime/scenes/'+shot.id+'.mjs',newUrl).href;
    assert.notEqual(new URL(oldUrl).pathname,new URL(newUrl).pathname);
    assert.equal(await (await fetch(oldSource)).text(),before);assert.match(before,/#0000ff/);assert.match(await (await fetch(newSource)).text(),/#ff0000/);
    const privateFile=new URL('../../../../.studio/state.sqlite',oldUrl);assert.equal((await fetch(privateFile)).status,403);
  }finally{await first.close();await second.close();await fs.rm(directory,{recursive:true,force:true});}
});
