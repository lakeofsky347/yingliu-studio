import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { AgentService, type ResolvedAgentModel } from '../src/agent/service.ts';
import type { AgentPort, Capabilities, PublicRun } from '../src/agent/tool-contracts.ts';
import type { StudioSnapshot, VideoProject } from '../src/shared/types.ts';
import { activeTools, createTools } from '../src/agent/tools.ts';
import { capabilityPrompt } from '../src/agent/context.ts';
import { synthesize } from '../src/agent/synth.ts';
import { toolGateway } from './model-gateway.ts';
import { startTemplateGateway } from './template-gateway.ts';
import { createApplication, MemorySecrets } from '../src/app/application.ts';

function port(caps: { value: Capabilities }) {
  const project = { ...createProject('能力测试'), id: 'p', revision: 1, shots: [{ id: 'a', title: 'A', intent: '', composition: '', action: '', durationFrames: 60, assetIds: [], referenceIds: [], params: {} }], shotOrder: ['a'] } as unknown as VideoProject;
  const calls: string[] = [];
  const value: AgentPort = {
    snapshot: async () => ({ project, root: null, task: null, environment: {} } as unknown as StudioSnapshot),
    readSource: async () => defaultSceneSource(), saveSource: async () => ({ project } as unknown as StudioSnapshot), commit: async () => ({ project } as unknown as StudioSnapshot),
    route: async endpoint => { calls.push(endpoint); return { ok: true, value: endpoint === 'media.generate' ? { id: 't1' } : { id: 't1', phase: 'ready' } }; },
    capture: async () => ({ bytes: new Uint8Array(4), mime: 'image/png', frame: 0, shotId: 'a' }),
    capabilities: async () => caps.value,
    generateAudio: async (_p, role, prompt) => { calls.push('audio:' + role + ':' + prompt); return { id: 'aud', name: role, cost: 0.2 }; },
    importAudio: async (_p, name, bytes) => { calls.push('import:' + name + ':' + bytes.length); return { id: 'syn', name }; },
  };
  return { port: value, calls };
}
const model = async (): Promise<ResolvedAgentModel> => ({ parameters: {}, vision: false, config: { baseUrl: 'http://gateway.test/v1', model: 'deepseek-chat', timeoutMs: 5000, maxTokens: 1000, supportsTools: true } });
async function settle(service: AgentService, id: string, until: PublicRun['status'][]) { for (let i = 0; i < 500; i++) { const run = await service.get(id); if (until.includes(run.status)) return run; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout ' + (await service.get(id)).status); }
const names = (body: any) => (body.tools ?? []).map((t: any) => t.function.name) as string[];

test('activeTools/capabilityPrompt: generation tools appear only when roles are bound; director self-makes otherwise', () => {
  const all = createTools();
  const none = activeTools(all, { roles: [] }).map(t => t.name);
  for (const tool of ['generate_image', 'generate_video', 'generate_voice', 'generate_music', 'generate_sfx', 'media_apply', 'visual_review']) assert.ok(!none.includes(tool), tool);
  assert.ok(none.includes('synthesize_sfx') && none.includes('shot_write_source'));
  const full = activeTools(all, { roles: ['image', 'video', 'speech', 'music', 'sfx', 'vision'] }).map(t => t.name);
  for (const tool of ['generate_image', 'generate_video', 'generate_voice', 'generate_music', 'generate_sfx', 'media_apply', 'visual_review']) assert.ok(full.includes(tool), tool);
  assert.ok(!full.includes('synthesize_sfx'));
  const prompt = capabilityPrompt([]); assert.match(prompt.text, /亲手绘制/); assert.deepEqual(prompt.selfMade, ['画面', '旁白', '音乐', '音效']);
  assert.match(capabilityPrompt(['image']).text, /generate_image/); assert.ok(capabilityPrompt(['image']).selfMade.includes('动态片段'));
  const wav = synthesize({ kind: 'chime', durationSeconds: 0.5 }); assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF'); assert.equal(wav.length, 44 + Math.floor(0.5 * 44100) * 2);
});

test('hot activation: binding roles mid-run exposes generation tools on the next step; cost tools still need approval', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-caps-')); const caps = { value: { roles: [] } as Capabilities }; const { port: p, calls } = port(caps);
  const gw = toolGateway((body, turn) => {
    if (turn === 0) { assert.ok(!names(body).includes('generate_video')); assert.match(body.messages[0].content, /亲手绘制/); caps.value = { roles: ['video', 'music'] }; return { toolCalls: [{ name: 'generate_image', arguments: { expectedRevision: 1, prompt: 'x' } }] }; }
    if (turn === 1) { assert.ok(names(body).includes('generate_video') && names(body).includes('generate_music')); assert.ok(!names(body).includes('generate_image'));
      assert.ok(body.messages.some((m: any) => m.role === 'tool' && /未激活/.test(m.content))); assert.ok(body.messages.some((m: any) => m.role === 'user' && /能力已变化/.test(m.content)));
      return { toolCalls: [{ id: 'm1', name: 'generate_music', arguments: { prompt: '轻快钢琴', durationSeconds: 10 } }] }; }
    return { text: '完成' };
  });
  const service = new AgentService(d, p, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0 });
  try {
    const s = await service.start({ projectId: 'p', goal: '做配乐' });
    let run = await settle(service, s.id, ['awaiting_approval', 'failed', 'complete']);
    assert.equal(run.status, 'awaiting_approval', run.message); assert.equal(run.pending?.tool, 'generate_music');
    assert.deepEqual(run.active?.roles, ['video', 'music']); assert.ok(run.active?.tools.includes('generate_video'));
    assert.ok(!calls.some(c => c.startsWith('audio:')));
    await service.approve(s.id, 'm1');
    run = await settle(service, s.id, ['complete', 'failed']);
    assert.equal(run.status, 'complete'); assert.ok(calls.includes('audio:music:轻快钢琴')); assert.equal(run.usage.cost, 0.2);
    const caps2 = await service.capabilities(); assert.deepEqual(caps2.capabilities.roles, ['video', 'music']); assert.ok(caps2.selfMade.includes('静态插画'));
    assert.ok((await service.trace(s.id)).some((e: any) => e.event === 'capabilities'));
  } finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

test('without sfx model the director synthesizes sound locally (free, no approval)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'agent-caps-')); const { port: p, calls } = port({ value: { roles: [] } });
  const gw = toolGateway((_b, turn) => turn === 0 ? { toolCalls: [{ name: 'synthesize_sfx', arguments: { name: '叮', kind: 'chime', durationSeconds: 0.4, frequency: 880 } }] } : { text: 'ok' });
  const service = new AgentService(d, p, { resolveModel: model, fetch: gw.fetch, maxReviewRounds: 0 });
  try { const s = await service.start({ projectId: 'p', goal: '加提示音' }); const run = await settle(service, s.id, ['complete', 'failed', 'awaiting_approval']); assert.equal(run.status, 'complete'); assert.ok(calls.some(c => c.startsWith('import:叮:'))); }
  finally { await service.dispose(); await rm(d, { recursive: true, force: true }); }
});

const hasFfprobe = (() => { try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('app integration: capabilities follow the registry; async music template generates and imports audio after approval', { skip: !hasFfprobe && 'ffprobe 不可用' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-caps-app-'));
  const wav = Buffer.from(synthesize({ kind: 'tone', durationSeconds: 1 }));
  const media = await startTemplateGateway({ audio: wav, pollsBeforeDone: 1 });
  let phase = 0;
  const gw = toolGateway((body) => {
    if (phase === 0) { phase = 1; assert.ok(!names(body).includes('generate_music')); return { toolCalls: [{ name: 'synthesize_sfx', arguments: { name: '提示', kind: 'click', durationSeconds: 0.3 } }] }; }
    if (phase === 1 && names(body).includes('generate_music')) { phase = 2; return { toolCalls: [{ id: 'gm', name: 'generate_music', arguments: { prompt: 'lofi', durationSeconds: 1 } }] }; }
    if (phase === 1) return { toolCalls: [{ name: 'project_get', arguments: {} }] };
    return { text: '完成' };
  });
  const app = await createApplication({ dataDirectory: directory, credentials: new MemorySecrets(), fetch: gw.fetch });
  const call = async <T,>(endpoint: string, payload: unknown = {}) => { const r = await app.route(endpoint, payload); if (!r.ok) throw new Error(endpoint + ': ' + r.error.message); return r.value as T; };
  try {
    const c = await call<{ id: string }>('models.connection.save', { name: 'gw', protocol: 'chat-completions', baseUrl: 'http://gateway.test/v1', auth: 'none' });
    const m = await call<{ id: string }>('models.model.save', { connectionId: c.id, model: 'deepseek-chat', inputModalities: ['text'], outputModalities: ['text'], parameters: {} });
    await call('models.role.bind', { role: 'director', modelId: m.id });
    const created = await call<StudioSnapshot>('create', { blank: true, title: '配乐', operationId: 'agent-capabilities-create', expectedRevision: null });
    const before = await call<{ capabilities: Capabilities; tools: { name: string }[] }>('agent.capabilities');
    assert.deepEqual(before.capabilities.roles, []); assert.ok(before.tools.some(t => t.name === 'synthesize_sfx'));
    const run = await call<PublicRun>('agent.start', { projectId: created.project!.id, goal: '加音效和音乐', maxReviewRounds: 0 });
    let current = run;
    for (let i = 0; i < 300 && phase < 1; i++) await new Promise(r => setTimeout(r, 10));
    // bind a Replicate-style music model while the run is going (hot activation)
    const rc = await call<{ id: string }>('models.connection.save', { name: 'music', protocol: 'async-task', baseUrl: media.url + '/v1', auth: 'none' });
    const rm2 = await call<{ id: string }>('models.model.save', { connectionId: rc.id, model: 'meta/musicgen', inputModalities: ['text'], outputModalities: ['audio'], parameters: { preset: 'replicate', pollIntervalMs: 5 } });
    await call('models.role.bind', { role: 'music', modelId: rm2.id });
    for (let i = 0; i < 500 && !['awaiting_approval', 'complete', 'failed'].includes(current.status); i++) { await new Promise(r => setTimeout(r, 10)); current = await call<PublicRun>('agent.get', { runId: run.id }); }
    assert.equal(current.status, 'awaiting_approval', current.message + JSON.stringify(current.steps.filter(s => s.error)));
    await call('agent.approve', { runId: run.id, callId: 'gm' });
    for (let i = 0; i < 500 && !['complete', 'failed'].includes(current.status); i++) { await new Promise(r => setTimeout(r, 10)); current = await call<PublicRun>('agent.get', { runId: run.id }); }
    assert.equal(current.status, 'complete', current.message + JSON.stringify(current.steps.filter(s => s.error)));
    const after = await call<StudioSnapshot>('current', { projectId: created.project!.id });
    assert.equal(after.project!.assets.filter(a => a.kind === 'audio').length, 2);
    assert.ok(media.requests.some(r => r.path === '/v1/models/meta%2Fmusicgen/predictions'));
  } finally { await app.dispose(); await media.close(); await rm(directory, { recursive: true, force: true }); }
});
