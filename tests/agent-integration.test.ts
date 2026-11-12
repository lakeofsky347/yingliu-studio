import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { MediaProjectPort, MediaTask } from '../src/jobs/contracts.ts';
import { startTemplateGateway } from './template-gateway.ts';
import { pngFixture } from './media-gateway.ts';

async function handlesUnder(root: string): Promise<string[]> {
  if (process.platform !== 'linux') return [];
  const hits: string[] = [];
  let fds: string[] = [];
  try { fds = await readdir('/proc/self/fd'); } catch { return hits; }
  for (const fd of fds) {
    try {
      const target = await readlink(`/proc/self/fd/${fd}`);
      if (target.startsWith(root)) hits.push(target);
    } catch { /* the descriptor closed while we were reading */ }
  }
  return hits;
}

async function settle(service: MediaTaskService, id: string, predicate: (task: MediaTask) => boolean) {
  for (let i = 0; i < 400; i++) {
    const task = await service.get(id);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('task did not settle: ' + JSON.stringify(await service.get(id)));
}

test('async-task generation restarts from the ledger with the same remote job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-async-restart-'));
  const gateway = await startTemplateGateway({ pollsBeforeDone: 80 });
  const values = new Map<string, string>();
  const registry = new ModelRegistry(directory, { async get(ref) { return values.get(ref); }, async set(ref, value) { values.set(ref, value); }, async delete(ref) { values.delete(ref); } });
  const port: MediaProjectPort = {
    async databasePath() { return join(directory, '.studio', 'state.sqlite'); },
    async inspect() { return { revision: 3, shotIds: ['shot-1'] }; },
    async readImage() { return { bytes: pngFixture, mime: 'image/png' }; },
    async validateArtifact() { return { mime: 'video/mp4' }; },
    async applyResult() { return { assetIds: ['asset'], revision: 4 }; },
  };
  let service = new MediaTaskService(directory, registry, port, { pollIntervalMs: 30 });
  try {
    const connection = await registry.saveConnection({ id: 'wanx', name: '通义万相', protocol: 'async-task', baseUrl: gateway.url + '/api/v1', apiKey: 'ds-secret' });
    await registry.saveModel({ id: 'wanx-video', connectionId: connection.id, model: 'wanx2.1-t2v-turbo', parameters: { preset: 'dashscope-video' } });
    await registry.bindRole('video', 'wanx-video');
    const started = await service.generate({ clientRequestId: 'async-restart-1', projectId: 'film', expectedRevision: 3, operation: 'text-to-video', prompt: '海边日落' });
    const submitted = await settle(service, started.id, task => Boolean(task.remoteJobId) && task.phase !== 'pending' && task.phase !== 'submitting');
    assert.equal(submitted.remoteJobId, 'ds-1');
    const postsBefore = gateway.requests.filter(request => request.method === 'POST' && request.path.includes('video-synthesis')).length;
    await service.dispose();
    service = new MediaTaskService(directory, registry, port, { pollIntervalMs: 30 });
    await service.recover();
    const restored = await service.get(started.id);
    assert.equal(restored.remoteJobId, submitted.remoteJobId);
    assert.equal(restored.clientRequestId, 'async-restart-1');
    assert.equal(restored.connection.protocol, 'async-task');
    assert.notEqual(restored.phase, 'pending');
    const replay = await service.generate({ clientRequestId: 'async-restart-1', projectId: 'film', expectedRevision: 3, operation: 'text-to-video', prompt: '海边日落' });
    assert.equal(replay.id, started.id);
    assert.equal(gateway.requests.filter(request => request.method === 'POST' && request.path.includes('video-synthesis')).length, postsBefore);
  } finally {
    await service.dispose();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('application dispose stops the tool agent and releases SQLite handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-dispose-handles-'));
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets() });
  try {
    const created = await app.route('create', { title: '关闭检查', operationId: 'dispose-create', expectedRevision: null });
    assert.equal(created.ok, true);
    const projectId = created.ok ? (created.value as { project: { id: string } }).project.id : '';
    assert.equal(typeof projectId, 'string');
    const session = await app.route('sessions.create', { projectId });
    assert.equal(session.ok, true, session.ok ? '' : session.error.message);
    assert.ok(app.agent);
    assert.ok(app.agents);
  } finally {
    await app.dispose();
  }
  const leftover = await handlesUnder(directory);
  assert.deepEqual(leftover, [], leftover.join('\n'));
  await rm(directory, { recursive: true, force: true });
  const after = await app.route('catalog');
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, 'APP_SHUTTING_DOWN');
});
