import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, MemorySecrets, ENDPOINTS } from '../src/app/application.ts';
import { startUiServer } from '../src/app/ui-server.ts';
import type { PublicRun } from '../src/agent/tool-contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { toolGateway } from './model-gateway.ts';
import { defaultSceneSource } from '../src/core/index.ts';

test('application exposes agent RPC; a scripted tool-calling model edits a real project through validated commits and streams SSE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-agent-app-'));
  let revision = -1;
  const gw = toolGateway(body => {
    const last = body.messages.at(-1);
    if (body.messages.length === 2) return { toolCalls: [{ name: 'project_get', arguments: {} }] };
    if (last.role === 'tool' && last.content.includes('"revision"') && revision < 0) { revision = JSON.parse(last.content).revision; return { toolCalls: [{ name: 'video_update', arguments: { expectedRevision: revision, update: { title: '智能体改过的标题', storyboard: { shots: [{ title: '开场', intent: '介绍', composition: '居中', action: '淡入', durationSeconds: 3, params: { text: '你好' } }] }, sourcesByIndex: [defaultSceneSource()] }, structural: true, label: '建立初稿' } }] }; }
    return { text: '已把标题改好。' };
  });
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets(), fetch: gw.fetch });
  const server = await startUiServer(app, join(process.cwd(), 'dist', 'ui'));
  const call = async <T,>(endpoint: string, payload: unknown = {}) => { const result = await app.route(endpoint, payload); if (!result.ok) throw new Error(endpoint + ': ' + result.error.message); return result.value as T; };
  try {
    for (const endpoint of ['agent.start', 'agent.approve', 'agent.reject', 'agent.resume', 'agent.trace']) assert.ok(ENDPOINTS.has(endpoint));
    const connection = await call<{ id: string }>('models.connection.save', { name: '本地智能体网关', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const model = await call<{ id: string }>('models.model.save', { connectionId: connection.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: model.id });
    const created = await call<StudioSnapshot>('create', { blank: true, title: '原标题', operationId: 'agent-app-create', expectedRevision: null });
    const projectId = created.project!.id;
    const tools = await call<{ tools: { name: string; risk: string }[] }>('agent.tools');
    assert.equal(tools.tools.find(t => t.name === 'export_mp4')?.risk, 'export');
    // SSE stream (token-gated)
    const page = await (await fetch(server.origin + '/')).text().catch(() => '');
    const token = /name="yingliu-token" content="([^"]+)"/.exec(page)?.[1];
    const denied = await fetch(server.origin + '/events/agent', { method: 'POST' }); assert.equal(denied.status, 403);
    const events: string[] = []; const abort = new AbortController();
    if (token) {
      const stream = await fetch(server.origin + '/events/agent?projectId=' + projectId, { method: 'POST', headers: { 'X-Yingliu-Token': token }, signal: abort.signal });
      assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      void (async () => { const reader = stream.body!.getReader(); try { while (true) { const n = await reader.read(); if (n.done) break; events.push(new TextDecoder().decode(n.value)); } } catch { /* aborted */ } })();
    }
    const run = await call<PublicRun>('agent.start', { projectId, goal: '把标题改成更好的', maxReviewRounds: 0 });
    let current = run;
    for (let i = 0; i < 300 && !['complete', 'failed', 'budget_exceeded'].includes(current.status); i++) { await new Promise(r => setTimeout(r, 20)); current = await call<PublicRun>('agent.get', { runId: run.id }); }
    assert.equal(current.status, 'complete', current.message);
    const after = await call<StudioSnapshot>('current', { projectId });
    assert.equal(after.project!.title, '智能体改过的标题'); assert.equal(after.project!.shots.length, 1);
    assert.equal(after.project!.revision, revision + 1);
    const trace = await call<{ events: { event: string }[] }>('agent.trace', { runId: run.id });
    assert.ok(trace.events.some(e => e.event === 'run.complete'));
    if (token) { await new Promise(r => setTimeout(r, 50)); assert.ok(events.join('').includes('"type":"run"')); }
    abort.abort();
  } finally { await server.close(); await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});
