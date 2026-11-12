import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCoordinator, type RootToolContext } from '../src/app/agent-coordinator.ts';
import { ProviderManager, type ModelMessage } from '../src/app/model.ts';
import type { AppBackend } from '../src/app/backend.ts';
import type { SecretStore } from '../src/app/contracts.ts';
import type { MediaTaskService } from '../src/jobs/media-tasks.ts';
import type { ModelSelection } from '../src/models/contracts.ts';
import type { AgentCandidatePayload, AgentScope, AgentTask, ValidationReceipt } from '../src/agent/contracts.ts';
import { candidateHash, contentHash, stableJson } from '../src/agent/repository.ts';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import type { SceneSource, StudioSnapshot } from '../src/shared/types.ts';

class Secrets implements SecretStore {
  private values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, value: string) { this.values.set(id, value); }
  async delete(id: string) { this.values.delete(id); }
}
interface ModelCall { messages: ModelMessage[]; system: string; signal: AbortSignal; selection: ModelSelection; sessionId: string }
class Models extends ProviderManager {
  calls: ModelCall[] = [];
  responder: (call: ModelCall) => unknown | Promise<unknown> = () => ({ type: 'blocked', reason: 'fixture finished' });
  override async complete(messages: ModelMessage[], system: string, signal: AbortSignal, _maxTokens?: number, selection: ModelSelection = 'scene', sessionId = 'unexpected-default-session'): Promise<string> {
    const call = { messages: structuredClone(messages), system, signal, selection, sessionId }; this.calls.push(call);
    return JSON.stringify(await this.responder(call));
  }
}
/** These ports assert coordinator boundaries only. Fixture bytes are never claimed to be browser evidence. */
class Backend {
  project = createProject('协调器边界测试');
  sources: Record<string, SceneSource>;
  reads: { endpoint: string; payload: Record<string, unknown> }[] = [];
  validations: AgentCandidatePayload[] = [];
  captures: { frame: number; hash: string }[] = [];
  constructor(readonly root: string) {
    this.project.shots[0]!.title = 'AUTHORIZED_SHOT';
    this.project.shots[1]!.title = 'PRIVATE_OTHER_SHOT';
    this.sources = Object.fromEntries(this.project.shots.map((shot, index) => [shot.id, { ...defaultSceneSource(), html: index === 0 ? '<main>AUTHORIZED_SOURCE_' + 'a'.repeat(3500) + '</main>' : '<main>PRIVATE_OTHER_SOURCE_' + index + '</main>' }]));
  }
  snapshot(): StudioSnapshot { return { project: structuredClone(this.project), root: this.root, task: null, previewUrl: null, previewRevision: null, providers: [], recent: [], environment: { browserPath: 'fixture', browserAvailable: true, ffmpegPath: 'fixture', ffmpegAvailable: true, ffprobePath: 'fixture', ffprobeAvailable: true } }; }
  async call<T = StudioSnapshot>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.reads.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === 'current') { assert.equal(payload.projectId, this.project.id); return this.snapshot() as T; }
    if (endpoint === 'source') { assert.equal(payload.projectId, this.project.id); assert.equal(payload.revision, this.project.revision); return structuredClone(this.sources[String(payload.shotId)]) as T; }
    throw new Error('Unexpected fixture backend call: ' + endpoint);
  }
  async validateCandidate(projectId: string, candidate: Pick<AgentCandidatePayload, 'project' | 'sources'>, signal: AbortSignal): Promise<ValidationReceipt> {
    assert.equal(projectId, this.project.id); signal.throwIfAborted();
    this.validations.push(structuredClone({ ...candidate, baseRevision: candidate.project.revision }));
    return { id: randomUUID(), candidateHash: candidateHash(candidate), baseRevision: candidate.project.revision, status: 'passed', checks: ['structure', 'syntax', 'assets', 'runtime'].map(id => ({ id, status: 'passed' })), frames: [], createdAt: new Date().toISOString(), validatorVersion: 'fixture-port-only-no-browser' };
  }
  async workflowCapture(projectId: string, frame: number, signal: AbortSignal, candidate: Pick<AgentCandidatePayload, 'project' | 'sources'>) {
    assert.equal(projectId, this.project.id); signal.throwIfAborted();
    const hash = contentHash({ frame, candidate: candidateHash(candidate), fixture: true }); this.captures.push({ frame, hash });
    return { bytes: Buffer.from('fixture-pixels-not-an-actual-render'), mime: 'image/png', sha256: hash };
  }
}
const rootScope: AgentScope = { shotIds: ['*'], writeFields: ['*'], capabilities: ['*'] };
const signal = () => new AbortController().signal;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yingliu-coordinator-')), backend = new Backend(join(directory, 'project'));
  await mkdir(join(backend.root, '.studio'), { recursive: true });
  const providers = new Models(directory, new Secrets());
  await providers.save({ apiKey: 'fixture-only-key', supportsVision: true, enableVision: true });
  await providers.registry.bindRole('vision', 'custom-model');
  const coordinator = new AgentCoordinator({ dataDirectory: directory, backend: backend as unknown as AppBackend, providers, media: {} as MediaTaskService, async voice() { throw new Error('Unexpected voice call'); } });
  const repo = await coordinator.repositoryFor(backend.project.id); let closed = false;
  const dispose = async () => { if (!closed) { closed = true; await coordinator.dispose(); } };
  t.after(async () => { await dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
  async function root(name = 'root', scope: AgentScope = rootScope): Promise<RootToolContext> {
    const session = await repo.createSession({ name }), task = await repo.createTask({ sessionId: session.id, goal: name, scope }), lease = await repo.claimTask(task.id, 'fixture-' + name);
    return { lease, projectId: backend.project.id, snapshot: backend.snapshot(), taskId: task.id, sessionId: session.id, toolOperationId: randomUUID(), request: { sessionId: session.id, projectId: backend.project.id, operationId: randomUUID(), expectedRevision: backend.project.revision, message: name, provider: 'custom', model: 'deepseek-chat', allowImageUpload: true } };
  }
  async function delegate(context: RootToolContext, extra: Record<string, unknown> = {}) {
    const result = await coordinator.externalTool('agent_delegate', { goal: '制作授权镜头', shotIds: [backend.project.shots[0]!.id], ...extra }, context, signal()) as { receipt: AgentTask };
    return result.receipt;
  }
  async function wait(context: RootToolContext, taskId: string) {
    return (await coordinator.externalTool('agent_wait', { taskId }, context, signal()) as { receipt: AgentTask }).receipt;
  }
  function codeResponder() {
    const rounds = new Map<string, number>();
    providers.responder = call => {
      const round = rounds.get(call.sessionId) ?? 0; rounds.set(call.sessionId, round + 1);
      return round === 0 ? { type: 'execute', tool: 'code', shotId: backend.project.shots[0]!.id, input: { source: { ...defaultSceneSource(), html: '<main>CHILD_CANDIDATE</main>' } } } : { type: 'submit', summary: '完成授权源码' };
    };
  }
  return { directory, backend, providers, coordinator, repo, root, delegate, wait, codeResponder, dispose };
}

test('coordinator source pagination exposes only the authorized shot and compact model context', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root(), shotId = f.backend.project.shots[0]!.id;
  let round = 0, page: { sourcePage: string; offset: number; nextOffset: number; totalChars: number } | undefined;
  f.providers.responder = call => {
    const serialized = JSON.stringify(call.messages);
    for (const secret of ['PRIVATE_OTHER_SHOT', 'PRIVATE_OTHER_SOURCE', 'fixture-only-key', root.lease.leaseOwner]) assert.ok(!serialized.includes(secret));
    if (round++ === 0) return { type: 'read', query: { shotIds: [shotId], fields: ['source'], offset: 17, limit: 64 } };
    page = JSON.parse(String(call.messages[1]!.content));
    return { type: 'blocked', reason: '检查分页完成' };
  };
  const child = await f.delegate(root), done = await f.wait(root, child.id);
  assert.equal(done.status, 'blocked'); assert.equal(f.providers.calls.length, 2); assert.ok(page);
  assert.equal(page.sourcePage, stableJson(f.backend.sources[shotId]).slice(17, 81));
  assert.equal(page.offset, 17); assert.equal(page.nextOffset, 81); assert.ok(page.totalChars > page.sourcePage.length);
  assert.equal(f.providers.calls[0]!.sessionId, child.sessionId); assert.notEqual(child.sessionId, root.sessionId);
  const receipt = await f.coordinator.externalTool('agent_result', { taskId: child.id }, root, signal());
  for (const secret of ['PRIVATE_OTHER_SOURCE', 'AUTHORIZED_SOURCE_', 'fixture-only-key', root.lease.leaseOwner]) assert.ok(!JSON.stringify(receipt).includes(secret));
});

test('model identity fields cannot replace the trusted root or child execution identity', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root();
  await assert.rejects(f.delegate({ ...root, sessionId: 'model-reported-session' }), { code: 'DELEGATION_DENIED' });
  await assert.rejects(f.delegate({ ...root, taskId: 'model-reported-task' }), { code: 'DELEGATION_DENIED' });
  await assert.rejects(f.delegate({ ...root, lease: { ...root.lease, leaseOwner: 'model-reported-owner' } }), { code: 'LEASE_LOST' });
  f.providers.responder = () => ({ type: 'execute', tool: 'code', shotId: f.backend.project.shots[0]!.id, input: { sessionId: root.sessionId, taskId: root.taskId, generation: root.lease.generation, source: defaultSceneSource() } });
  const child = await f.delegate(root, { taskId: 'forged-task', generation: 99, leaseOwner: 'forged-owner' }), done = await f.wait(root, child.id);
  assert.notEqual(child.id, 'forged-task'); assert.equal(child.parentTaskId, root.taskId); assert.equal(Object.hasOwn(child, 'leaseOwner'), false);
  assert.equal(done.status, 'failed'); assert.equal((await f.repo.getTask(child.id)).checkpoint, 'TOOL_DENIED'); assert.equal(f.backend.validations.length, 0); assert.equal((await f.repo.listCandidates(child.id)).length, 0);
});

test('replayed delegate operation after a HEAD change returns the original child without re-freezing or spawning', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root();
  const child = await f.delegate(root); await f.wait(root, child.id);
  const reads = f.backend.reads.length, calls = f.providers.calls.length;
  f.backend.project.revision++; f.backend.project.shots[1]!.title = '另一个进程改动';
  const replay = await f.delegate(root);
  assert.equal(replay.id, child.id); assert.equal(replay.sessionId, child.sessionId); assert.equal(f.backend.reads.length, reads); assert.equal(f.providers.calls.length, calls);
  assert.equal((await f.repo.listTasks()).filter(task => task.parentTaskId === root.taskId).length, 1); assert.equal((await f.repo.getBudget(root.taskId)).children, 1);
  await assert.rejects(f.delegate(root, { goal: '同一操作换了目标' }), { code: 'OPERATION_MISMATCH' });
});

test('a negative visual verdict remains rejected even when deterministic fixture checks pass', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root(); let normalCalls = 0, visualCalls = 0;
  f.providers.responder = call => {
    if (call.system.startsWith('依据实际关键帧审片')) {
      visualCalls++; const content = call.messages[0]!.content; assert.ok(Array.isArray(content));
      const evidence = JSON.parse(content.find(part => part.type === 'text')!.text);
      assert.ok(content.some(part => part.type === 'image_url')); assert.equal(evidence.frames[0].sha256, f.backend.captures[0]!.hash);
      return { verdict: 'fail', candidateHash: evidence.candidateHash, findings: ['主文字无法阅读（fixture verdict）'] };
    }
    if (normalCalls++ === 0) return { type: 'execute', tool: 'code', shotId: f.backend.project.shots[0]!.id, input: { source: defaultSceneSource() } };
    if (normalCalls === 2) return { type: 'submit', summary: '提交视觉检查' };
    return { type: 'blocked', reason: '等待修复负面审片结论' };
  };
  const child = await f.delegate(root, { acceptance: ['视觉文字必须清晰'] }), done = await f.wait(root, child.id), candidates = await f.repo.listCandidates(child.id);
  assert.equal(done.status, 'blocked'); assert.equal(visualCalls, 1); assert.equal(candidates.length, 1); assert.equal(candidates[0]!.status, 'rejected');
  const validation = await f.repo.getValidation(candidates[0]!.validationId!);
  assert.equal(validation.status, 'failed'); assert.equal(validation.candidateHash, candidates[0]!.hash); assert.equal(validation.checks.find(check => check.id === 'visual-verdict')?.status, 'failed');
  await assert.rejects(f.coordinator.externalTool('agent_accept', { candidateId: candidates[0]!.id }, root, signal()), { code: 'VALIDATION_REQUIRED' });
});

test('acceptance rejects changed read dependencies without consuming the validated result', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root(); f.codeResponder();
  const child = await f.delegate(root), done = await f.wait(root, child.id); assert.equal(done.status, 'awaiting-acceptance', done.error);
  f.backend.project.revision++; f.backend.sources[f.backend.project.shots[0]!.id] = { ...defaultSceneSource(), html: '<main>CONCURRENT_SOURCE</main>' };
  await assert.rejects(f.coordinator.externalTool('agent_accept', { candidateId: done.candidateId }, root, signal()), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.repo.getCandidate(done.candidateId!)).status, 'validated'); assert.equal((await f.repo.getTask(child.id)).status, 'awaiting-acceptance');
});

test('acceptance rebases only authorized changes and preserves unrelated concurrent fields and sources', { timeout: 10000 }, async t => {
  const f = await fixture(t), root = await f.root(); f.codeResponder();
  const child = await f.delegate(root), done = await f.wait(root, child.id); assert.equal(done.status, 'awaiting-acceptance', done.error);
  const otherId = f.backend.project.shots[1]!.id; f.backend.project.revision++; f.backend.project.title = '并行修改的片名'; f.backend.project.shots[1]!.title = '并行修改的其他镜头'; f.backend.sources[otherId] = { ...defaultSceneSource(), html: '<main>CONCURRENT_OTHER_SOURCE</main>' };
  const accepted = await f.coordinator.externalTool('agent_accept', { candidateId: done.candidateId }, root, signal()) as { receipt: { status: string }; acceptedCandidate: AgentCandidatePayload };
  assert.equal(accepted.receipt.status, 'accepted'); assert.equal(accepted.acceptedCandidate.baseRevision, f.backend.project.revision); assert.equal(accepted.acceptedCandidate.project.revision, f.backend.project.revision);
  assert.equal(accepted.acceptedCandidate.project.title, f.backend.project.title); assert.equal(accepted.acceptedCandidate.project.shots[1]!.title, f.backend.project.shots[1]!.title);
  assert.deepEqual(Object.keys(accepted.acceptedCandidate.sources), [f.backend.project.shots[0]!.id]);
  assert.equal(accepted.acceptedCandidate.sources[f.backend.project.shots[0]!.id]!.html, '<main>CHILD_CANDIDATE</main>');
  assert.equal(f.backend.sources[otherId]!.html, '<main>CONCURRENT_OTHER_SOURCE</main>'); assert.equal((await f.repo.getTask(child.id)).status, 'succeeded');
});

test('first concurrent roots share one owned runtime and cancellation plus disposal abort every remaining model request', { timeout: 10000 }, async t => {
  const f = await fixture(t), roots = await Promise.all([f.root('root-a'), f.root('root-b')]);
  const active = new Map<string, AbortSignal>(); let entered!: () => void; const bothEntered = new Promise<void>(resolve => { entered = resolve; });
  f.providers.responder = call => new Promise((_, reject) => {
    active.set(call.sessionId, call.signal); if (active.size === 2) entered();
    call.signal.addEventListener('abort', () => { active.delete(call.sessionId); reject(call.signal.reason); }, { once: true });
  });
  const children = await Promise.all(roots.map(root => f.delegate(root))); await bothEntered;
  await f.coordinator.externalTool('agent_cancel', { taskId: children[0]!.id }, roots[0]!, signal());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.repo.getTask(children[0]!.id)).status, 'cancelled'); assert.ok(active.has(children[1]!.sessionId)); assert.equal(active.get(children[1]!.sessionId)?.aborted, false);
  await f.dispose(); assert.equal(active.size, 0); assert.equal(f.providers.calls.length, 2);
  for (const call of f.providers.calls) assert.equal(call.signal.aborted, true);
});

test('visual frame selection follows shotOrder rather than storage array order', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.backend.project.shots[0]!.durationFrames = 20; f.backend.project.shots[1]!.durationFrames = 60;
  f.backend.project.shotOrder = [f.backend.project.shots[1]!.id, f.backend.project.shots[0]!.id, ...f.backend.project.shotOrder.slice(2)];
  const root = await f.root(); let round = 0;
  f.providers.responder = call => {
    if (call.system.startsWith('依据实际关键帧审片')) { const content = call.messages[0]!.content; assert.ok(Array.isArray(content)); const evidence = JSON.parse(content.find(part => part.type === 'text')!.text); return { verdict: 'pass', candidateHash: evidence.candidateHash, findings: [] }; }
    return round++ === 0 ? { type: 'execute', tool: 'code', shotId: f.backend.project.shots[0]!.id, input: { source: defaultSceneSource() } } : { type: 'submit', summary: '镜头顺序检查' };
  };
  const child = await f.delegate(root, { acceptance: ['视觉检查授权镜头'] }), done = await f.wait(root, child.id); assert.equal(done.status, 'awaiting-acceptance', done.error);
  assert.deepEqual(f.backend.captures.map(capture => capture.frame), [70]);
});

test('a vision member cannot promote its negative submitted evidence to a validated result', { timeout: 30000 }, async t => {
  const f = await fixture(t), root = await f.root(); let round = 0;
  f.providers.responder = call => {
    const content = call.messages.at(-1)!.content; assert.ok(Array.isArray(content));
    const metadata = JSON.parse(content.find(part => part.type === 'text')!.text);
    assert.ok(content.some(part => part.type === 'image_url'));
    if (round++ === 0) return { type: 'read', query: { shotIds: [f.backend.project.shots[0]!.id], fields: ['title'] } };
    if (round === 2) return { type: 'submit', summary: 'fixture负面视觉结论', evidence: { verdict: 'fail', candidateHash: metadata.candidateHash, findings: ['画面需要修复'] } };
    return { type: 'blocked', reason: '需要导演决定视觉修复' };
  };
  const child = await f.delegate(root, { role: 'vision' }), done = await f.wait(root, child.id), candidates = await f.repo.listCandidates(child.id);
  assert.equal(done.status, 'blocked'); assert.equal(candidates.length, 1); assert.equal(candidates[0]!.status, 'rejected');
  const validation = await f.repo.getValidation(candidates[0]!.validationId!);
  assert.equal(validation.status, 'failed'); assert.equal(validation.checks.find(check => check.id === 'visual-verdict')?.status, 'failed');
  assert.equal((await f.repo.getTask(child.id)).scope.writeFields.length, 0);
});
