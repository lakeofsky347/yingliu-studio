import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/core/index.ts';
import { StudioController } from '../src/client/controller.ts';
import { PendingOperationRequests, SessionRequests, recoveryLabel } from '../src/client/agent-client.ts';
import type { StudioApi, StudioSnapshot } from '../src/shared/types.ts';

function fixture(handler?: (endpoint: string, payload: Record<string, unknown>) => unknown) {
  let snapshot: StudioSnapshot = { project: createProject('会话隔离测试'), root: '/tmp/agent-client', task: null, previewUrl: null, previewRevision: null, providers: [], recent: [], environment: { browserPath: '', ffmpegPath: '', ffprobePath: '', browserAvailable: false, ffmpegAvailable: false, ffprobeAvailable: false } };
  const calls: { endpoint: string; payload: Record<string, unknown> }[] = [];
  const api: StudioApi = { async call<T>(endpoint: string, input: unknown = {}) {
    const payload = input as Record<string, unknown>; calls.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === 'history') return { canUndo: false, canRedo: false, entries: [], cursor: 0 } as T;
    const result = handler?.(endpoint, payload);
    return (result === undefined ? structuredClone(snapshot) : await result) as T;
  } };
  return { calls, controller: new StudioController(api), get snapshot() { return snapshot; }, set snapshot(value: StudioSnapshot) { snapshot = value; } };
}

test('an unresolved mutation reuses its operation identity, while new successful actions do not', async () => {
  let attempts = 0;
  const f = fixture(endpoint => { if (endpoint === 'rename' && ++attempts === 1) throw new Error('connection lost after dispatch'); });
  await f.controller.load();
  assert.equal(await f.controller.action('rename', { title: '新标题' }), false);
  assert.equal(await f.controller.action('rename', { title: '新标题' }), true);
  assert.equal(await f.controller.action('rename', { title: '新标题' }), true);
  const writes = f.calls.filter(call => call.endpoint === 'rename').map(call => call.payload);
  assert.equal(typeof writes[0].operationId, 'string');
  assert.equal(writes[0].operationId, writes[1].operationId);
  assert.notEqual(writes[1].operationId, writes[2].operationId);
  assert.deepEqual(writes.map(write => write.expectedRevision), [0, 0, 0]);
  await f.controller.dispose();
});

test('a changed revision or changed payload cannot reuse an unfinished operation id', () => {
  const requests = new PendingOperationRequests();
  const first = requests.prepare('saveSource', { expectedRevision: 1, source: 'first' });
  assert.notEqual(first.payload.operationId, requests.prepare('saveSource', { expectedRevision: 2, source: 'first' }).payload.operationId);
  assert.notEqual(first.payload.operationId, requests.prepare('saveSource', { expectedRevision: 1, source: 'corrected' }).payload.operationId);
});

test('session A can finish or be cancelled without completing or occupying session B', () => {
  const requests = new SessionRequests(), a = requests.begin('a'), b = requests.begin('b');
  assert.throws(() => requests.begin('a'), /已有请求/);
  assert.equal(requests.finish('a', b), false);
  assert.equal(requests.finish('a', a), true);
  assert.equal(requests.pending('b'), true);
  const nextA = requests.begin('a');
  assert.equal(requests.finish('a', a), false);
  assert.equal(requests.pending('a'), true);
  assert.equal(requests.finish('b', b), true);
  assert.equal(requests.finish('a', nextA), true);
});

test('creation carries a null baseline and task cancellation carries the selected task identity', async () => {
  const f = fixture(); await f.controller.load();
  await f.controller.action('create', { title: '新工程' });
  assert.equal(f.calls.find(call => call.endpoint === 'create')?.payload.expectedRevision, null);
  assert.ok(f.calls.find(call => call.endpoint === 'create')?.payload.operationId);
  await f.controller.action('cancel', { expectedTaskId: 'task-a' });
  assert.equal(f.calls.find(call => call.endpoint === 'cancel')?.payload.expectedTaskId, 'task-a');
  const count = f.calls.filter(call => call.endpoint === 'cancel').length;
  assert.equal(await f.controller.action('cancel'), false);
  assert.equal(f.calls.filter(call => call.endpoint === 'cancel').length, count);
  await f.controller.dispose();
});

test('workflows use the selected root session and media retries preserve the supplier identity', async () => {
  let attempts = 0;
  const f = fixture(endpoint => { if (endpoint === 'media.generate' && ++attempts === 1) throw new Error('response lost'); });
  await f.controller.load(); f.controller.setAgentSession('root-a');
  await f.controller.mediaCommand('workflows.run', { prompt: '制作镜头' });
  f.controller.setAgentSession('root-b');
  await f.controller.mediaCommand('workflows.run', { prompt: '制作镜头' });
  const workflows = f.calls.filter(call => call.endpoint === 'workflows.run');
  assert.deepEqual(workflows.map(call => call.payload.sessionId), ['root-a', 'root-b']);
  assert.notEqual(workflows[0].payload.operationId, workflows[1].payload.operationId);
  await assert.rejects(f.controller.mediaCommand('media.generate', { prompt: '一张图片' }));
  await f.controller.mediaCommand('media.generate', { prompt: '一张图片' });
  const media = f.calls.filter(call => call.endpoint === 'media.generate');
  assert.equal(media[0].payload.clientRequestId, media[0].payload.operationId);
  assert.equal(media[0].payload.clientRequestId, media[1].payload.clientRequestId);
  await f.controller.dispose();
});

test('recovery labels distinguish committed validation from a paused step and a conflict', () => {
  assert.equal(recoveryLabel({ status: 'failed', committedRevision: 8 }), '重新验证已保存结果');
  assert.equal(recoveryLabel({ status: 'paused' }), '继续未完成步骤');
  assert.equal(recoveryLabel({ status: 'awaiting-rebase' }), '复核冲突后继续');
  assert.equal(recoveryLabel({ status: 'failed' }), '修复失败步骤');
});
