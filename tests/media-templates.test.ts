import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistry } from '../src/models/registry.ts';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { MediaProjectPort, MediaTask } from '../src/jobs/contracts.ts';
import { fillBody, fillPath, mapStatus, parseTemplateJob, pick, resolveTemplate, submitTemplate, pollTemplate, checkTemplate, TEMPLATE_PRESETS } from '../src/models/adapters/template.ts';
import { pngFixture } from './media-gateway.ts';
import { startTemplateGateway } from './template-gateway.ts';
import { ProviderManager } from '../src/app/model.ts';
import { MemorySecrets } from '../src/app/application.ts';

const vars = { prompt: 'say "hi"\\n}', model: 'm-1', clientRequestId: 'c', parameters: { size: '512*512' } };
test('template body filling is injection-safe, typed, and drops absent optional inputs', () => {
  const body = fillBody('{"model":"{{model}}","input":{"prompt":"{{prompt}}","img_url":"{{image}}"},"parameters":{"size":"{{param.size|1024*1024}}","duration":{{duration|5}},"n":1},"tag":"p-{{model}}"}', vars) as any;
  assert.equal(body.input.prompt, vars.prompt); assert.ok(!('img_url' in body.input)); assert.equal(body.parameters.duration, 5); assert.equal(body.parameters.size, '512*512'); assert.equal(body.tag, 'p-m-1');
  assert.equal(fillPath('/tasks/{{id}}', { ...vars, id: 'a/b' }), '/tasks/a%2Fb');
  assert.deepEqual(pick({ output: { results: [{ url: 'u1' }, { url: 'u2' }] } }, 'output.results[].url'), ['u1', 'u2']);
  assert.deepEqual(pick({ data: [{ url: 'x' }] }, 'data[0].url'), ['x']);
  assert.deepEqual(pick({ output: 'only' }, 'output[]'), ['only']);
  assert.equal(mapStatus('SUCCEEDED', TEMPLATE_PRESETS['dashscope-video'].template.statusMap!), 'succeeded');
  assert.equal(mapStatus('succeed', TEMPLATE_PRESETS['kling-video'].template.statusMap!), 'succeeded');
  assert.throws(() => resolveTemplate({ preset: 'nope' }), /未知/);
  assert.throws(() => resolveTemplate({ submitPath: '/../x' }), /路径/);
  assert.throws(() => resolveTemplate({ extraHttpName: 'X-Api-Key', extraHttpValue: 's' }), /凭据/);
  assert.throws(() => parseTemplateJob({ id: 'x', status: 'succeeded' }, resolveTemplate({}), 'c', 'image'), /resultPath/);
  for (const [key, preset] of Object.entries(TEMPLATE_PRESETS)) { const t = resolveTemplate({ preset: key }); assert.ok(t.submitPath.startsWith('/'), key); JSON.parse(t.submitBody.replace(/\{\{[^}]+\}\}/g, '0')); assert.ok(['image', 'video', 'audio'].includes(preset.output)); }
});

async function fixture(t: TestContext, gatewayOptions: Parameters<typeof startTemplateGateway>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'template-media-')), gateway = await startTemplateGateway(gatewayOptions); const values = new Map<string, string>();
  const registry = new ModelRegistry(directory, { async get(ref) { return values.get(ref); }, async set(ref, value) { values.set(ref, value); }, async delete(ref) { values.delete(ref); } });
  let revision = 3, applies = 0;
  const port: MediaProjectPort = { async databasePath() { return join(directory, '.studio', 'state.sqlite'); }, async inspect() { return { revision, shotIds: ['shot-1'] }; }, async readImage() { return { bytes: pngFixture, mime: 'image/png' }; }, async validateArtifact(path, mime) { assert.ok((await readFile(path)).length > 10); return { mime }; }, async applyResult(input) { applies++; revision++; return { assetIds: ['asset-' + applies], revision }; } };
  const service = new MediaTaskService(directory, registry, port, { pollIntervalMs: 5 });
  t.after(async () => { await service.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, gateway, registry, service, generate(input: Omit<Parameters<MediaTaskService['generate']>[0], 'clientRequestId'> & { clientRequestId?: string }) { return service.generate({ ...input, clientRequestId: input.clientRequestId ?? randomUUID() }); } };
}
async function settle(service: MediaTaskService, id: string, predicate: (task: MediaTask) => boolean) { for (let i = 0; i < 400; i++) { const task = await service.get(id); if (predicate(task)) return task; await new Promise(r => setTimeout(r, 10)); } throw new Error('task did not settle: ' + JSON.stringify(await service.get(id))); }

test('DashScope-style async video: submit with async header, poll until SUCCEEDED, download without credentials', async t => {
  const f = await fixture(t, { pollsBeforeDone: 2 });
  const connection = await f.registry.saveConnection({ id: 'wanx', name: '通义万相', protocol: 'async-task', baseUrl: f.gateway.url + '/api/v1', apiKey: 'ds-secret' });
  const model = await f.registry.saveModel({ id: 'wanx-video', connectionId: connection.id, model: 'wanx2.1-t2v-turbo', parameters: { preset: 'dashscope-video' } });
  assert.deepEqual(model.outputModalities, ['video']);
  await f.registry.bindRole('video', model.id);
  const task = await f.generate({ projectId: 'film', expectedRevision: 3, operation: 'text-to-video', prompt: '海边日落' });
  const ready = await settle(f.service, task.id, x => x.phase === 'ready' || x.phase === 'failed');
  assert.equal(ready.phase, 'ready', ready.error); assert.equal(ready.remoteJobId, 'ds-1');
  const submit = f.gateway.requests.find(r => r.method === 'POST')!;
  assert.equal(submit.path, '/api/v1/services/aigc/video-generation/video-synthesis'); assert.equal(submit.headers['x-dashscope-async'], 'enable'); assert.equal(submit.headers.authorization, 'Bearer ds-secret');
  assert.equal((submit.body as any).input.prompt, '海边日落'); assert.equal((submit.body as any).model, 'wanx2.1-t2v-turbo');
  assert.ok(f.gateway.requests.filter(r => r.path === '/api/v1/tasks/ds-1').length >= 3);
  assert.equal(f.gateway.requests.find(r => r.path.startsWith('/files/'))?.headers.authorization, undefined);
});
test('DashScope image, Kling video and failed status map through the same template adapter', async t => {
  const f = await fixture(t, { pollsBeforeDone: 1 });
  const ds = await f.registry.saveConnection({ id: 'ds', name: 'DS', protocol: 'async-task', baseUrl: f.gateway.url + '/api/v1', apiKey: 'k' });
  await f.registry.saveModel({ id: 'wanx-image', connectionId: ds.id, model: 'wanx2.1-t2i', parameters: { preset: 'dashscope-image', size: '512*512' } });
  await f.registry.bindRole('image', 'wanx-image');
  const image = await f.generate({ projectId: 'film', expectedRevision: 3, operation: 'text-to-image', prompt: '猫' });
  assert.equal((await settle(f.service, image.id, x => ['ready', 'failed', 'unknown'].includes(x.phase))).phase, 'ready');
  assert.equal((f.gateway.requests.find(r => r.method === 'POST')!.body as any).parameters.size, '512*512');
  const kling = await f.registry.saveConnection({ id: 'kling', name: '可灵', protocol: 'async-task', baseUrl: f.gateway.url, apiKey: 'jwt' });
  await f.registry.saveModel({ id: 'kling-v', connectionId: kling.id, model: 'kling-v1', parameters: { preset: 'kling-video' } });
  await f.registry.bindRole('video', 'kling-v');
  const video = await f.generate({ projectId: 'film', expectedRevision: 3, operation: 'text-to-video', prompt: '城市' });
  const done = await settle(f.service, video.id, x => ['ready', 'failed'].includes(x.phase));
  assert.equal(done.phase, 'ready'); assert.ok(done.remoteJobId?.startsWith('kl-'));
  assert.equal((f.gateway.requests.find(r => r.path === '/v1/videos/text2video')!.body as any).model_name, 'kling-v1');
});
test('failed remote status surfaces; binary audio and Replicate-style polling work; connectivity check never generates', async t => {
  const f = await fixture(t, { failStatus: true });
  const ds = await f.registry.saveConnection({ id: 'ds', name: 'DS', protocol: 'async-task', baseUrl: f.gateway.url + '/api/v1', apiKey: 'k' });
  await f.registry.saveModel({ id: 'wv', connectionId: ds.id, model: 'wanx', parameters: { preset: 'dashscope-video' } }); await f.registry.bindRole('video', 'wv');
  const task = await f.generate({ projectId: 'film', expectedRevision: 3, operation: 'text-to-video', prompt: 'x' });
  assert.equal((await settle(f.service, task.id, x => ['ready', 'failed'].includes(x.phase))).phase, 'failed');
  const el = await f.registry.saveConnection({ id: 'el', name: 'EL', protocol: 'async-task', baseUrl: f.gateway.url, apiKey: 'el-key' });
  const sfx = await f.registry.saveModel({ id: 'sfx', connectionId: el.id, model: 'sfx', parameters: { preset: 'elevenlabs-sfx' } });
  assert.deepEqual(sfx.outputModalities, ['audio']); await f.registry.bindRole('sfx', 'sfx');
  await assert.rejects(f.registry.bindRole('image', 'sfx'), /不匹配/);
  const binary = await submitTemplate({ connection: (await f.registry.resolve('sfx')).connection, key: 'el-key', signal: AbortSignal.timeout(5000) }, { clientRequestId: 'c', model: sfx, prompt: '玻璃碎裂', duration: 2, parameters: {} }, 'audio');
  assert.ok('kind' in binary && binary.bytes.length > 100);
  const sound = f.gateway.requests.find(r => r.path === '/v1/sound-generation')!; assert.equal(sound.headers['xi-api-key'], 'el-key'); assert.equal(sound.headers.authorization, undefined); assert.equal((sound.body as any).duration_seconds, 2);
  const rp = await f.registry.saveConnection({ id: 'rp', name: 'Replicate', protocol: 'async-task', baseUrl: f.gateway.url + '/v1', apiKey: 'r8' });
  const music = await f.registry.saveModel({ id: 'music', connectionId: rp.id, model: 'meta/musicgen', outputModalities: ['audio'], parameters: { preset: 'replicate' } });
  await f.registry.bindRole('music', 'music');
  const context = { connection: rp, key: 'r8', signal: AbortSignal.timeout(5000) };
  let job = await submitTemplate(context, { clientRequestId: 'c', model: music, prompt: 'lofi', parameters: {} }, 'audio');
  assert.ok(!('kind' in job)); assert.equal(job.status, 'queued');
  for (let i = 0; i < 5 && job.status !== 'succeeded'; i++) job = await pollTemplate(context, music, job.jobId, 'audio');
  assert.equal(job.status, 'succeeded'); assert.equal(job.artifacts?.[0].mimeType, 'audio/mpeg');
  assert.equal(f.gateway.requests.find(r => r.path === '/v1/models/meta%2Fmusicgen/predictions')?.method, 'POST');
  const before = f.gateway.requests.length;
  assert.equal((await checkTemplate({ connection: rp, key: 'r8', signal: AbortSignal.timeout(5000) }, { ...music, parameters: { preset: 'replicate', checkPath: '/denied/' } })).ok, false);
  assert.ok(f.gateway.requests.slice(before).every(r => r.method === 'GET'));
  const manager = new ProviderManager(f.directory + '-pm', new MemorySecrets()); await manager.initialize();
  const c = await manager.registry.saveConnection({ name: 'tpl', protocol: 'async-task', baseUrl: f.gateway.url, auth: 'none' });
  const checked = await manager.check(c.id); assert.equal(checked.ok, true); assert.match(checked.message, /不提交生成任务/);
  await rm(f.directory + '-pm', { recursive: true, force: true });
});
