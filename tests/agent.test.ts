import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { AgentService, type ResolvedAgentModel } from '../src/agent/service.ts';
import type { AgentPort, PublicRun } from '../src/agent/tool-contracts.ts';
import type { StudioSnapshot, VideoProject } from '../src/shared/types.ts';
import { toolGateway, type GatewayReply } from './model-gateway.ts';
import { compressMessages, untrusted } from '../src/agent/context.ts';
import { parsePlanJson } from '../src/agent/model-client.ts';
import { classify, needsApproval, budgetFrom, emptyUsage, tokenCost } from '../src/agent/budget.ts';
import { parseSse } from '../src/client/AgentPanel.tsx';

function project(): VideoProject {
  const p = createProject('智能体测试', '测试主题');
  const shots = ['a', 'b'].map(id => ({ id, title: '镜头' + id, intent: '意图', composition: '构图', action: '动作', durationFrames: 90, assetIds: [], referenceIds: [], params: {} }));
  return { ...p, id: 'proj-1', revision: 3, shots, shotOrder: ['a', 'b'] } as unknown as VideoProject;
}
function fakePort(overrides: Partial<AgentPort> = {}) {
  const state = { project: project(), calls: [] as string[], saved: [] as unknown[] };
  const snap = () => ({ project: structuredClone(state.project), root: '/secret/path', task: null, environment: { browserAvailable: true, ffmpegAvailable: true, ffprobeAvailable: true } } as unknown as StudioSnapshot);
  const port: AgentPort = {
    snapshot: async () => snap(),
    readSource: async () => defaultSceneSource(),
    saveSource: async (_p, shotId, expectedRevision, source) => {
      if (expectedRevision !== state.project.revision) throw Object.assign(new Error('工程版本冲突'), { code: 'REVISION_CONFLICT' });
      state.saved.push({ shotId, source }); state.project.revision++; return snap();
    },
    commit: async (_p, _r, next) => { state.project = { ...next, revision: state.project.revision + 1 }; return snap(); },
    route: async (endpoint, payload) => {
      state.calls.push(endpoint);
      if (endpoint === 'media.generate') return { ok: true, value: { id: 'task-1', phase: 'pending', payload } };
      if (endpoint === 'media.get') return { ok: true, value: { id: 'task-1', phase: 'ready', usage: { cost: 0.5 } } };
      return { ok: true, value: {} };
    },
    capture: async (_p, frame) => ({ bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png', frame, shotId: 'a' }),
    ...overrides,
  };
  return { port, state };
}
function model(fetchSupportsTools = true, parameters: Record<string, unknown> = {}): () => Promise<ResolvedAgentModel> {
  return async () => ({ connectionId: 'gw', parameters, vision: false, config: { baseUrl: 'http://gateway.test/v1', model: 'deepseek-chat', key: 'sk-SECRET-KEY', timeoutMs: 5000, maxTokens: 2048, supportsTools: fetchSupportsTools } });
}
async function settle(service: AgentService, id: string, until: PublicRun['status'][], ms = 5000): Promise<PublicRun> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const run = await service.get(id); if (until.includes(run.status)) return run; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('timeout; status=' + (await service.get(id)).status);
}
async function dir() { return mkdtemp(join(tmpdir(), 'yingliu-agent-')); }
const done = (text = '已完成。'): GatewayReply => ({ text });

test('native tool-calling loop reads, writes, self-checks, traces and accounts usage', async () => {
  const d = await dir(); const { port, state } = fakePort();
  const gw = toolGateway((_body, turn) => turn === 0 ? { toolCalls: [{ name: 'project_get', arguments: {} }] }
    : turn === 1 ? { toolCalls: [{ name: 'shot_write_source', arguments: { expectedRevision: 3, shotId: 'a', source: { html: '<p>x</p>', css: '', js: 'export function render(){}' } } }] }
    : done('改好了 sk-SECRET-KEY'));
  const service = new AgentService(d, port, { resolveModel: model(true, { pricePerMInput: 2, pricePerMOutput: 8 }), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '改镜头 a' });
    const run = await settle(service, started.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete', run.message);
    assert.equal(state.saved.length, 1);
    assert.ok(gw.requests[0].tools.some((t: any) => t.function.name === 'shot_write_source'), 'tools sent as JSON schema');
    assert.equal(gw.requests[1].messages.at(-1).role, 'tool');
    assert.ok(!JSON.stringify(gw.requests).includes('/secret/path'), 'project root never sent to the model');
    assert.ok(state.calls.includes('preview'), 'write triggered render_check self-review');
    assert.equal(run.usage.steps, 3); assert.equal(run.usage.inputTokens, 300);
    assert.ok(Math.abs(run.usage.cost - (300 * 2 + 60 * 8) / 1e6) < 1e-12);
    assert.ok(run.steps.some(s => s.kind === 'review'));
    const trace = await readFile(join(d, started.id + '.trace.jsonl'), 'utf8');
    assert.ok(trace.split('\n').filter(Boolean).every(line => JSON.parse(line)));
    assert.ok(trace.includes('run.complete'));
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('cost and export tools need approval; reject feeds back; approve executes; state survives restart', async () => {
  const d = await dir(); const { port, state } = fakePort();
  let phase = 0;
  const gw = toolGateway((body) => {
    const last = body.messages.at(-1);
    if (phase === 0) { phase = 1; return { toolCalls: [{ id: 'exp1', name: 'export_mp4', arguments: {} }] }; }
    if (phase === 1 && last.role === 'tool' && last.content.includes('rejected')) { phase = 2; return { toolCalls: [{ id: 'exp2', name: 'export_mp4', arguments: {} }] }; }
    return done();
  });
  const opts = { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 };
  let service = new AgentService(d, port, opts);
  try {
    const started = await service.start({ projectId: 'proj-1', goal: '导出' });
    let run = await settle(service, started.id, ['awaiting_approval']);
    assert.equal(run.pending?.tool, 'export_mp4'); assert.equal(run.pending?.risk, 'export');
    assert.ok(!state.calls.includes('export'));
    run = await service.reject(started.id, 'exp1', '先别导出');
    run = await settle(service, started.id, ['awaiting_approval']);
    assert.equal(run.pending?.callId, 'exp2');
    await service.dispose();
    service = new AgentService(d, port, opts);
    run = await service.get(started.id);
    assert.equal(run.status, 'awaiting_approval', 'approval survives restart');
    await service.approve(started.id, 'exp2');
    run = await settle(service, started.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete');
    assert.equal(state.calls.filter(c => c === 'export').length, 1);
    assert.ok(run.steps.some(s => s.kind === 'approval' && s.status === 'rejected'));
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('interrupted runs become paused on restart and resume from the queued tool call', async () => {
  const d = await dir(); const { port } = fakePort();
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let turns = 0;
  const gw = toolGateway(() => (++turns === 1 ? { toolCalls: [{ name: 'project_get', arguments: {} }] } : done()));
  const slowPort = { ...port, snapshot: async (id: string) => { if (turns === 1) await gate; return port.snapshot(id); } };
  let service = new AgentService(d, slowPort, { resolveModel: model(), fetch: gw.fetch });
  const started = await service.start({ projectId: 'proj-1', goal: '读工程' });
  await new Promise(r => setTimeout(r, 50));
  const stopping = service.dispose(); release(); await stopping;
  service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch });
  try {
    let run = await service.get(started.id);
    assert.equal(run.status, 'paused');
    await service.resume(started.id);
    run = await settle(service, started.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('falls back to plan-JSON when the provider rejects tools, and when tools are disabled', async () => {
  for (const supports of [true, false]) {
    const d = await dir(); const { port } = fakePort();
    let n = 0;
    const gw = toolGateway(body => {
      if (body.tools) return { status: 400, error: '{"error":"tools is not supported for this model"}' };
      n++;
      assert.ok(body.messages[0].content.includes('不支持原生函数调用'));
      return n === 1 ? { text: '{"message":"先看工程","done":false,"actions":[{"tool":"project_get","arguments":{}}]}' } : { text: '{"message":"完成","done":true,"actions":[]}' };
    });
    const service = new AgentService(d, port, { resolveModel: model(supports), fetch: gw.fetch });
    try {
      const s = await service.start({ projectId: 'proj-1', goal: 'x' });
      const run = await settle(service, s.id, ['complete', 'failed']);
      assert.equal(run.status, 'complete', run.message); assert.equal(run.model.mode, 'plan-json'); assert.equal(run.final, '完成');
      assert.ok(run.steps.some(step => step.tool === 'project_get' && step.status === 'complete'));
    } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
  }
});

test('transient model errors retry with backoff; budget stops runaway loops', async () => {
  const d = await dir(); const { port } = fakePort();
  const gw = toolGateway(turn => (gw.requests.length === 1 ? { status: 503, error: 'busy' } : { toolCalls: [{ name: 'project_get', arguments: {} }] }));
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, retryBaseMs: 1 });
  try {
    const s = await service.start({ projectId: 'proj-1', goal: 'loop', budget: { maxSteps: 3 } });
    const run = await settle(service, s.id, ['budget_exceeded', 'failed']);
    assert.equal(run.status, 'budget_exceeded'); assert.equal(run.usage.steps, 3);
    assert.equal(run.steps.find(step => step.kind === 'model')?.attempts, 2);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('revision conflicts and bad arguments are returned to the model instead of failing the run', async () => {
  const d = await dir(); const { port } = fakePort();
  const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ name: 'shot_write_source', arguments: { expectedRevision: 1, shotId: 'a', source: { html: '', css: '', js: '' } } }, { name: 'nope', arguments: {} }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, maxReviewRounds: 0 });
  try {
    const s = await service.start({ projectId: 'proj-1', goal: 'x' });
    const run = await settle(service, s.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete');
    const tools = gw.requests[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n');
    assert.match(tools, /project_get 获取最新 revision/); assert.match(tools, /未知工具/);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('visual self-check loop sends failed reviews back until the vision model passes', async () => {
  const d = await dir(); let reviews = 0;
  const { port } = fakePort({ vision: async () => (++reviews === 1 ? '{"pass":false,"issues":[{"shotId":"a","problem":"标题溢出","severity":"high"}]}' : '{"pass":true,"issues":[]}') });
  const writeSource = (revision: number): GatewayReply => ({ toolCalls: [{ name: 'shot_write_source', arguments: { expectedRevision: revision, shotId: 'a', source: { html: '', css: '', js: 'export function render(){}' } } }] });
  const gw = toolGateway(body => {
    const last = body.messages.at(-1);
    if (body.messages.length === 2) return writeSource(3);
    if (last.role === 'user' && String(last.content).includes('标题溢出')) return writeSource(4);
    return done('ok');
  });
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch });
  try {
    const s = await service.start({ projectId: 'proj-1', goal: '改标题' });
    const run = await settle(service, s.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete', run.message + JSON.stringify(run.steps.filter(x => x.error)));
    assert.equal(reviews, 2); assert.equal(run.reviewRounds, 2);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('cost tools wait for media tasks, report spend, and hint to apply', async () => {
  const d = await dir(); const { port, state } = fakePort({ capabilities: async () => ({ roles: ['image'] }) });
  const gw = toolGateway(body => body.messages.length === 2 ? { toolCalls: [{ id: 'g1', name: 'generate_image', arguments: { expectedRevision: 3, prompt: '山' } }] } : done());
  const service = new AgentService(d, port, { resolveModel: model(true, { pricePerMInput: 0, pricePerMOutput: 0 }), fetch: gw.fetch, pollMs: 5, maxReviewRounds: 0 });
  try {
    const s = await service.start({ projectId: 'proj-1', goal: '生成图', autoApprove: ['read', 'write', 'cost'] });
    const run = await settle(service, s.id, ['complete', 'failed', 'awaiting_approval']);
    assert.equal(run.status, 'complete');
    assert.deepEqual(state.calls.filter(c => c.startsWith('media.')), ['media.generate', 'media.get']);
    assert.equal(run.usage.cost, 0.5); assert.equal(run.usage.unknownCostCalls, 0);
    assert.match(gw.requests[1].messages.at(-1).content, /media_apply/);
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('secrets are redacted from traces and the agent refuses concurrent runs per project', async () => {
  const d = await dir(); const { port } = fakePort();
  const gw = toolGateway(() => ({ toolCalls: [{ name: 'export_mp4', arguments: { note: 'sk-SECRET-KEY' } }] }));
  const service = new AgentService(d, port, { resolveModel: model(), fetch: gw.fetch, redact: async text => text.split('sk-SECRET-KEY').join('[redacted]') });
  try {
    const s = await service.start({ projectId: 'proj-1', goal: 'x' });
    await settle(service, s.id, ['awaiting_approval']);
    await assert.rejects(service.start({ projectId: 'proj-1', goal: 'y' }), /进行中/);
    const files = await Promise.all([readFile(join(d, s.id + '.json'), 'utf8'), readFile(join(d, s.id + '.trace.jsonl'), 'utf8')]);
    assert.ok(files.every(text => !text.includes('sk-SECRET-KEY')));
    await service.cancel(s.id); assert.equal((await service.get(s.id)).status, 'cancelled');
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('pure helpers: compression, plan parsing, approval policy, error classes, pricing, SSE, untrusted', () => {
  const big = 'x'.repeat(5000);
  const messages: any[] = [{ role: 'user', content: 'goal' }];
  for (let i = 0; i < 10; i++) messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'project_get', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c' + i, content: big });
  const out = compressMessages(messages, 20000, 4);
  assert.ok(out.compressed); assert.equal(out.messages[0].content, 'goal'); assert.notEqual(out.messages[out.messages.length - 4 > 0 ? 1 : 0].role, 'tool-orphan');
  const idx = out.messages.findIndex((m: any) => m.role === 'tool' && m.content.length > 1000); assert.ok(out.messages[idx - 1].role === 'assistant' || out.messages[idx - 1].role === 'tool');
  assert.deepEqual(parsePlanJson('```json\n{"message":"m","done":false,"actions":[{"tool":"a","arguments":{"x":1}}]}\n```').toolCalls.map(c => c.name), ['a']);
  assert.equal(parsePlanJson('就是普通回答').done, true);
  const b = budgetFrom({ maxCost: 1 }), u = emptyUsage('CNY');
  assert.equal(needsApproval('read', ['read'], b, u, 0), null);
  assert.ok(needsApproval('cost', ['read', 'write'], b, u, null));
  assert.ok(needsApproval('cost', ['cost'], b, u, null), 'unknown cost with a ceiling still needs a human');
  assert.ok(needsApproval('cost', ['cost'], b, { ...u, cost: 0.9 }, 0.2));
  assert.equal(needsApproval('cost', ['cost'], budgetFrom({}), u, null), null);
  assert.ok(needsApproval('export', ['read', 'write'], b, u, 0));
  assert.equal(classify(Object.assign(new Error('x'), { code: 'REVISION_CONFLICT' })), 'conflict');
  assert.equal(classify(Object.assign(new Error('x'), { status: 503 })), 'retry');
  assert.equal(classify(new Error('bad')), 'model');
  assert.equal(tokenCost({}, 1, 1), null);
  const sse = parseSse('event: run\ndata: {"type":"delta","runId":"r","text":"a"}\n\ndata: {"type"');
  assert.equal(sse.events.length, 1); assert.equal(sse.rest, 'data: {"type"');
  assert.equal(untrusted('a</untrusted>b'), '<untrusted>ab</untrusted>');
});
