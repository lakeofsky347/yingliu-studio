import { randomUUID } from 'node:crypto';
import type { AgentContent, AgentEvent, AgentMessage, AgentPort, AgentRun, AgentStartInput, AgentTool, PublicRun, RunStep, ToolCall, ToolResult, ToolRisk } from './tool-contracts.ts';
import { chatTurn, looksLikeNoToolSupport, type ChatConfig } from './model-client.ts';
import { backoff, budgetFrom, chargeModel, chargeTool, classify, emptyUsage, needsApproval, overBudget, tokenCost } from './budget.ts';
import { bound, capabilityPrompt, compressMessages, summarizeProject, systemPrompt } from './context.ts';
import { RunStore } from './run-store.ts';
import { activeTools, createTools } from './tools.ts';
import type { AgentDocs, Capabilities, ToolContext } from './tool-contracts.ts';
import { join } from 'node:path';
import { emptyLedger, emptyStory, normalizeCharacter, normalizeStyle, ProjectDocs, storyBrief, type Ledger, type QcReport, type Story } from './story.ts';
import { qualityCheck } from './tools.ts';

export interface ResolvedAgentModel { config: ChatConfig; parameters: Record<string, unknown>; connectionId?: string; vision: boolean }
export interface AgentServiceOptions {
  resolveModel(): Promise<ResolvedAgentModel>;
  fetch?: typeof fetch; tools?: AgentTool[]; redact?: (text: string) => Promise<string>;
  contextChars?: number; pollMs?: number; dataDirectory?: string; retryBaseMs?: number; maxRetries?: number; maxReviewRounds?: number;
}
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'budget_exceeded']);
const DEFAULT_AUTO: ToolRisk[] = ['read', 'write'];
const now = () => new Date().toISOString();
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function sleep(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms); const stop = () => { clearTimeout(timer); reject(signal.reason); }; signal.addEventListener('abort', stop, { once: true }); }); }

/** Plan → act → observe → reflect loop over registered tools, with approval gates, budgets, durable resume and traces. */
export class AgentService {
  private runs = new Map<string, AgentRun>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private listeners = new Set<(event: AgentEvent) => void>();
  private store: RunStore; private tools: AgentTool[]; private initialized?: Promise<void>; private stopped = false;
  private imageBuffer = new Map<string, AgentContent[]>();
  private stories: ProjectDocs<Story>; private ledgers: ProjectDocs<Ledger>; private qcs: ProjectDocs<{ version: number; report?: QcReport }>;
  constructor(directory: string, private readonly port: AgentPort, private readonly options: AgentServiceOptions) {
    this.store = new RunStore(directory, options.redact); this.tools = options.tools ?? createTools();
    const base = options.dataDirectory ?? directory;
    this.stories = new ProjectDocs(join(base, 'stories'), emptyStory); this.ledgers = new ProjectDocs(join(base, 'ledger'), emptyLedger); this.qcs = new ProjectDocs(join(base, 'qc'), () => ({ version: 0 }));
  }
  get toolList(): readonly AgentTool[] { return this.tools; }
  docs(projectId: string): AgentDocs {
    return {
      story: () => this.stories.get(projectId),
      updateStory: (change, expected) => this.stories.update(projectId, change, expected),
      ledger: () => this.ledgers.get(projectId),
      saveQc: async report => { await this.qcs.update(projectId, current => ({ ...current, report })); },
    };
  }
  story(projectId: string) { return this.stories.get(projectId); }
  /** User edits from the UI (style, characters, logline). Shots are changed through the agent's plan_shots or here wholesale. */
  async saveStory(projectId: string, input: Record<string, unknown>, expectedVersion: number): Promise<Story> {
    return this.stories.update(projectId, current => {
      const next = { ...current, updatedAt: now() };
      if (typeof input.title === 'string') next.title = input.title.trim().slice(0, 80);
      if (typeof input.logline === 'string') next.logline = input.logline.trim().slice(0, 1200);
      if (input.style !== undefined) next.style = normalizeStyle(input.style);
      if (Array.isArray(input.characters)) { const list = input.characters.slice(0, 20).map(normalizeCharacter); const used = new Set(next.shots.flatMap(s => s.characters)); const missing = [...used].filter(id => !list.some(c => c.id === id)); if (missing.length) throw new Error('分镜仍在使用这些角色，不能删除：' + missing.join(', ')); next.characters = list; }
      if (input.status === 'empty') { next.status = 'empty'; delete next.approvedAt; }
      return next;
    }, expectedVersion);
  }
  ledger(projectId: string) { return this.ledgers.get(projectId); }
  setProjectBudget(projectId: string, maxCost: number | null, currency?: string): Promise<Ledger> {
    if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0)) throw new Error('费用上限须为非负数，或留空表示不限');
    return this.ledgers.update(projectId, current => ({ ...current, maxCost, ...(currency ? { currency: currency.slice(0, 8) } : {}), updatedAt: now() }));
  }
  async lastQc(projectId: string) { return (await this.qcs.get(projectId)).report ?? null; }
  async runQc(projectId: string, signal = new AbortController().signal): Promise<QcReport> { return qualityCheck(this.context('qc', projectId, signal)); }
  private context(runId: string, projectId: string, signal: AbortSignal): ToolContext { return { runId, projectId, signal, port: this.port, docs: this.docs(projectId) }; }
  private async spend(projectId: string, tool: string, cost: number | null | undefined, settleUnknown = false) {
    await this.ledgers.update(projectId, current => {
      const entry = current.byTool[tool] ?? { calls: 0, cost: 0 };
      if (!settleUnknown) entry.calls++;
      if (typeof cost === 'number') { entry.cost += cost; current.spent += cost; if (settleUnknown) current.unknownCostCalls = Math.max(0, current.unknownCostCalls - 1); } else if (!settleUnknown) current.unknownCostCalls++;
      return { ...current, byTool: { ...current.byTool, [tool]: entry }, updatedAt: now() };
    });
  }
  /** Current capability snapshot (hot: re-read before every model step). */
  async capabilities(): Promise<{ capabilities: Capabilities; tools: { name: string; risk: string; description: string }[]; selfMade: string[] }> {
    const capabilities = await this.port.capabilities?.().catch(() => ({ roles: [] })) ?? { roles: this.port.vision ? ['vision' as const] : [] };
    const tools = activeTools(this.tools, capabilities);
    return { capabilities, tools: tools.map(tool => ({ name: tool.name, risk: tool.risk, description: tool.description })), selfMade: capabilityPrompt(capabilities.roles).selfMade };
  }
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      for (const run of await this.store.loadAll()) {
        if (run.status === 'running' || run.status === 'waiting_task') { run.status = 'paused'; run.message = '应用重启时运行被中断，可点击「继续」从断点恢复'; await this.store.save(run); }
        this.runs.set(run.id, run);
      }
    })();
  }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: AgentEvent) { for (const listener of this.listeners) { try { listener(event); } catch { /* listener errors never break the loop */ } } }
  public(run: AgentRun): PublicRun {
    const { messages, ...rest } = structuredClone(run);
    const transcript = messages.slice(1).map(message => ({
      role: message.role,
      content: typeof message.content === 'string' ? bound(message.content, 2000) : Array.isArray(message.content) ? message.content.map(part => part.type === 'text' ? part.text : '[图片]').join('\n') : '',
      ...(message.role === 'assistant' && message.tool_calls?.length ? { tool: message.tool_calls.map(call => call.function.name).join(', ') } : {}),
    }));
    return { ...rest, transcript };
  }
  private async save(run: AgentRun) { run.updatedAt = now(); await this.store.save(run); this.emit({ type: 'run', run: this.public(run) }); }
  private async step(run: AgentRun, step: Omit<RunStep, 'index' | 'startedAt'>): Promise<RunStep> {
    const value: RunStep = { index: run.steps.length, startedAt: now(), ...step }; run.steps.push(value);
    await this.store.trace(run.id, { event: 'step.start', step: value }); this.emit({ type: 'step', runId: run.id, step: value }); return value;
  }
  private async finishStep(run: AgentRun, step: RunStep, patch: Partial<RunStep>) {
    Object.assign(step, patch, { finishedAt: now() }); step.durationMs = Date.parse(step.finishedAt!) - Date.parse(step.startedAt);
    await this.store.trace(run.id, { event: 'step.finish', step }); this.emit({ type: 'step', runId: run.id, step });
  }
  private async required(id: string) { await this.initialize(); const run = this.runs.get(id); if (!run) throw new Error('智能体运行不存在'); return run; }
  async list(projectId?: string) { await this.initialize(); return [...this.runs.values()].filter(run => !projectId || run.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => this.public(run)); }
  async get(id: string) { return this.public(await this.required(id)); }
  async trace(id: string) { await this.required(id); return this.store.readTrace(id); }

  async start(input: AgentStartInput): Promise<PublicRun> {
    await this.initialize(); if (this.stopped) throw new Error('智能体服务正在关闭');
    if (typeof input.projectId !== 'string' || !input.projectId) throw new Error('缺少工程');
    const goal = String(input.goal ?? '').trim(); if (!goal || goal.length > 8000) throw new Error('目标须为 1–8000 字');
    if ([...this.runs.values()].some(run => run.projectId === input.projectId && !TERMINAL.has(run.status) && run.status !== 'paused')) throw new Error('该工程已有进行中的智能体运行，请先完成、暂停或取消');
    const snapshot = await this.port.snapshot(input.projectId);
    if (!snapshot.project || snapshot.project.id !== input.projectId) throw new Error('工程不存在或未打开');
    const budget = budgetFrom(input.budget), autoApprove = (input.autoApprove ?? DEFAULT_AUTO).filter(risk => ['read', 'write', 'plan', 'cost', 'export'].includes(risk));
    if (!autoApprove.includes('read')) autoApprove.push('read');
    const run: AgentRun = {
      version: 1, id: randomUUID(), projectId: input.projectId, goal, status: 'running', message: '智能体正在规划', createdAt: now(), updatedAt: now(),
      model: {}, budget, usage: emptyUsage(budget.currency), policy: { autoApprove },
      messages: [{ role: 'user', content: `目标：${goal}\n\n当前工程摘要：${JSON.stringify(summarizeProject(snapshot.project))}` }],
      steps: [], queue: [], approvedCallIds: [], reviewRounds: 0,
    };
    (run as AgentRun & { maxReviewRounds?: number }).maxReviewRounds = Number.isSafeInteger(input.maxReviewRounds) ? Math.max(0, Math.min(5, input.maxReviewRounds!)) : this.options.maxReviewRounds ?? 2;
    (run as AgentRun & { allowImages?: boolean }).allowImages = input.allowImages === true;
    this.runs.set(run.id, run); await this.store.trace(run.id, { event: 'run.start', goal, budget, autoApprove }); await this.save(run);
    this.launch(run); return this.public(run);
  }
  private launch(run: AgentRun) {
    if (this.active.has(run.id)) return;
    const controller = new AbortController();
    const promise = this.loop(run, controller.signal).catch(async error => {
      if (controller.signal.aborted) return;
      run.status = 'failed'; run.error = errorText(error); run.message = '运行失败：' + run.error; await this.store.trace(run.id, { event: 'run.failed', error: run.error }); await this.save(run);
    }).finally(() => { this.active.delete(run.id); });
    this.active.set(run.id, { controller, promise });
  }
  async approve(id: string, callId: string): Promise<PublicRun> {
    const run = await this.required(id); if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
    run.approvedCallIds.push(callId); await this.store.trace(run.id, { event: 'approval', callId, decision: 'approved', tool: run.pending.tool });
    const step = [...run.steps].reverse().find((s: RunStep) => s.kind === 'approval' && s.callId === callId); if (step) await this.finishStep(run, step, { status: 'complete', summary: '用户已批准' });
    delete run.pending; run.status = 'running'; run.message = '已批准，继续执行'; await this.save(run); this.launch(run); return this.public(run);
  }
  async reject(id: string, callId: string, reason = ''): Promise<PublicRun> {
    const run = await this.required(id); if (run.status !== 'awaiting_approval' || run.pending?.callId !== callId) throw new Error('没有待批准的这一步');
    const tool = run.pending.tool; await this.store.trace(run.id, { event: 'approval', callId, decision: 'rejected', tool, reason });
    const step = [...run.steps].reverse().find((s: RunStep) => s.kind === 'approval' && s.callId === callId); if (step) await this.finishStep(run, step, { status: 'rejected', summary: '用户拒绝' + (reason ? '：' + reason : '') });
    run.queue = run.queue.filter(call => call.id !== callId);
    run.messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ rejected: true, reason: reason.slice(0, 500) || '用户拒绝执行此操作，请换一种方式或说明原因' }) });
    delete run.pending; run.status = 'running'; run.message = '已拒绝，智能体调整方案'; await this.save(run); this.launch(run); return this.public(run);
  }
  async resume(id: string): Promise<PublicRun> {
    const run = await this.required(id); if (!['paused', 'failed', 'waiting_task'].includes(run.status) || this.active.has(id)) throw new Error('当前状态不能继续');
    if (run.status === 'failed' && !run.queue.length) run.messages.push({ role: 'user', content: '上一步失败：' + (run.error ?? '') + '。请根据当前工程重新判断并继续。' });
    run.status = run.waiting ? 'waiting_task' : 'running'; delete run.error; run.message = '从断点继续'; await this.store.trace(run.id, { event: 'run.resume' }); await this.save(run); this.launch(run); return this.public(run);
  }
  async pause(id: string): Promise<PublicRun> {
    const run = await this.required(id); const active = this.active.get(id);
    active?.controller.abort(new Error('用户暂停')); await active?.promise.catch(() => {});
    if (!TERMINAL.has(run.status) && run.status !== 'awaiting_approval') { run.status = 'paused'; run.message = '已暂停，可继续'; await this.store.trace(run.id, { event: 'run.pause' }); await this.save(run); }
    return this.public(run);
  }
  async cancel(id: string): Promise<PublicRun> {
    const run = await this.required(id); const active = this.active.get(id);
    active?.controller.abort(new Error('用户取消')); await active?.promise.catch(() => {});
    if (!TERMINAL.has(run.status)) { run.status = 'cancelled'; run.message = '已取消'; delete run.pending; run.queue = []; await this.store.trace(run.id, { event: 'run.cancel' }); await this.save(run); }
    return this.public(run);
  }
  async dispose() { this.stopped = true; for (const { controller } of this.active.values()) controller.abort(new Error('应用正在关闭')); await Promise.allSettled([...this.active.values()].map(item => item.promise)); }

  private async withRetry<T>(run: AgentRun, step: RunStep, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const max = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try { step.attempts = attempt + 1; return await work(); }
      catch (error) {
        if (signal.aborted || classify(error) !== 'retry' || attempt >= max) throw error;
        await this.store.trace(run.id, { event: 'retry', step: step.index, attempt: attempt + 1, error: errorText(error) });
        await sleep(backoff(attempt, this.options.retryBaseMs ?? 500), signal);
      }
    }
  }

  private async loop(run: AgentRun, signal: AbortSignal): Promise<void> {
    let model = await this.options.resolveModel();
    if (run.model.mode === 'plan-json') model = { ...model, config: { ...model.config, supportsTools: false } };
    run.model = { connectionId: model.connectionId, model: model.config.model, mode: model.config.supportsTools ? 'tools' : 'plan-json' };
    const meta = run as AgentRun & { maxReviewRounds?: number; allowImages?: boolean; dirty?: boolean };
    while (true) {
      signal.throwIfAborted();
      if (run.waiting) { await this.awaitTask(run, signal); continue; }
      if (run.queue.length) {
        const call = run.queue[0];
        const outcome = await this.runCall(run, call, model, signal);
        if (outcome === 'suspend') return;
        continue;
      }
      const images = this.imageBuffer.get(run.id); if (images?.length) { run.messages.push({ role: 'user', content: [{ type: 'text', text: '上面工具截取的画面：' }, ...images] }); this.imageBuffer.delete(run.id); }
      const limit = overBudget(run.budget, run.usage);
      const ledger = await this.ledgers.get(run.projectId);
      if (!limit && ledger.maxCost !== null && ledger.spent >= ledger.maxCost) { run.status = 'budget_exceeded'; run.message = `已停止：项目累计花费 ${ledger.spent.toFixed(2)} 已达上限 ${ledger.maxCost} ${ledger.currency}`; await this.store.trace(run.id, { event: 'budget', reason: 'project', ledger }); await this.save(run); return; }
      if (limit) { run.status = 'budget_exceeded'; run.message = '已停止：' + limit; await this.store.trace(run.id, { event: 'budget', reason: limit, usage: run.usage }); await this.save(run); return; }
      const compressed = compressMessages(run.messages, this.options.contextChars ?? 120_000);
      if (compressed.compressed) { run.messages = compressed.messages; const s = await this.step(run, { kind: 'compress', status: 'running' }); await this.finishStep(run, s, { status: 'complete', summary: '已压缩较早的上下文' }); }
      const caps = await this.capabilities(), tools = activeTools(this.tools, caps.capabilities), roleText = capabilityPrompt(caps.capabilities.roles);
      const brief = storyBrief(await this.stories.get(run.projectId)), planRule = brief ? brief : '工程还没有已批准的创作计划：多镜头或有角色的目标，先用 plan_story（剧本/风格/角色）和 plan_shots（分镜表）提交计划，等用户批准后再动手；简单的单镜头修改可以直接做。写镜头源码前可用 skill_read 查阅导演技能文档。';
      const promptExtra = roleText.text + '\n' + planRule;
      const changed = JSON.stringify(run.active?.tools) !== JSON.stringify(tools.map(t => t.name));
      if (run.active && changed) { run.messages.push({ role: 'user', content: '（系统通知）可用生成能力已变化：' + roleText.text }); await this.store.trace(run.id, { event: 'capabilities', roles: caps.capabilities.roles, tools: tools.map(t => t.name) }); }
      run.active = { roles: caps.capabilities.roles, tools: tools.map(t => t.name), selfMade: roleText.selfMade };
      run.message = '模型思考中'; await this.save(run);
      const step = await this.step(run, { kind: 'model', status: 'running' });
      let turn;
      try {
        turn = await this.withRetry(run, step, async () => {
          try { return await chatTurn(model.config, systemPrompt(promptExtra), run.messages, tools, signal, this.options.fetch); }
          catch (error) {
            if (model.config.supportsTools && looksLikeNoToolSupport(error)) {
              model = { ...model, config: { ...model.config, supportsTools: false } }; run.model.mode = 'plan-json';
              await this.store.trace(run.id, { event: 'fallback', to: 'plan-json', error: errorText(error) });
              return chatTurn(model.config, systemPrompt(promptExtra), run.messages, tools, signal, this.options.fetch);
            }
            throw error;
          }
        }, signal);
      } catch (error) { if (signal.aborted) throw error; await this.finishStep(run, step, { status: 'failed', error: errorText(error) }); throw error; }
      run.usage.steps++;
      const cost = tokenCost(model.parameters, turn.usage.inputTokens, turn.usage.outputTokens); chargeModel(run.usage, turn.usage.inputTokens, turn.usage.outputTokens, cost); if (cost) await this.spend(run.projectId, 'director', cost);
      await this.store.trace(run.id, { event: 'model', mode: turn.mode, finish: turn.finish, usage: turn.usage, cost, content: bound(turn.content, 4000), toolCalls: turn.toolCalls });
      run.messages.push({ role: 'assistant', content: turn.content || null, ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) } : {}) });
      await this.finishStep(run, step, { status: 'complete', summary: turn.toolCalls.length ? '计划调用：' + turn.toolCalls.map(call => call.name).join(', ') : bound(turn.content, 200) });
      if (turn.toolCalls.length) { run.queue = [...turn.toolCalls]; await this.save(run); continue; }
      if (turn.finish === 'length') { run.messages.push({ role: 'user', content: '上一条输出被截断，请更简短地继续。' }); continue; }
      // Reflection: verify writes visually before accepting "done".
      if (meta.dirty && run.reviewRounds < (meta.maxReviewRounds ?? 2)) {
        run.reviewRounds++; meta.dirty = false;
        const review = await this.selfCheck(run, signal);
        if (review && !review.pass) { run.messages.push({ role: 'user', content: `自检（第 ${run.reviewRounds} 轮）发现问题，请修复后再总结：\n${review.text}` }); await this.save(run); continue; }
      }
      await this.store.trace(run.id, { event: 'run.complete', usage: run.usage }); run.status = 'complete'; run.final = turn.content; run.message = '已完成'; await this.save(run); return;
    }
  }

  private async selfCheck(run: AgentRun, signal: AbortSignal): Promise<{ pass: boolean; text: string } | null> {
    const name = this.port.vision && (await this.capabilities()).capabilities.roles.includes('vision') ? 'visual_review' : 'render_check', tool = this.tools.find(item => item.name === name); if (!tool) return null;
    const step = await this.step(run, { kind: 'review', status: 'running', tool: name });
    try {
      const result = await tool.run({}, this.context(run.id, run.projectId, signal));
      let pass = true;
      try { const value = JSON.parse(result.content.slice(result.content.indexOf('{'), result.content.lastIndexOf('}') + 1)); pass = value.skipped === true || value.pass === true || (name === 'render_check' && value.status === 'complete' && !value.error); } catch { pass = false; }
      await this.finishStep(run, step, { status: 'complete', summary: (pass ? '自检通过：' : '自检发现问题：') + bound(result.content, 300) });
      return { pass, text: result.content };
    } catch (error) { if (signal.aborted) throw error; await this.finishStep(run, step, { status: 'failed', error: errorText(error) }); return { pass: false, text: '自检失败：' + errorText(error) }; }
  }

  private async runCall(run: AgentRun, call: ToolCall, model: ResolvedAgentModel, signal: AbortSignal): Promise<'next' | 'suspend'> {
    const meta = run as AgentRun & { dirty?: boolean; allowImages?: boolean };
    const active = activeTools(this.tools, (await this.capabilities()).capabilities);
    const tool = active.find(item => item.name === call.name);
    const respond = (content: string) => { run.messages.push({ role: 'tool', tool_call_id: call.id, content }); run.queue.shift(); };
    if (!tool) { respond(JSON.stringify({ error: (this.tools.some(t => t.name === call.name) ? '该工具当前未激活（对应模型未接入）：' : '未知工具：') + call.name + '。可用：' + active.map(t => t.name).join(', ') })); await this.save(run); return 'next'; }
    if (call.arguments.length > 2_100_000) { respond(JSON.stringify({ error: '工具参数超过 2MB 上限' })); await this.save(run); return 'next'; }
    let args: Record<string, unknown>;
    try { const parsed = JSON.parse(call.arguments || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('参数须为对象'); args = parsed; }
    catch (error) { respond(JSON.stringify({ error: '参数不是有效 JSON 对象：' + errorText(error) })); await this.save(run); return 'next'; }
    if (!run.approvedCallIds.includes(call.id)) {
      const estimate = tool.estimate?.(args) ?? (tool.risk === 'cost' ? null : 0);
      const reason = needsApproval(tool.risk, run.policy.autoApprove, run.budget, run.usage, estimate, tool.risk === 'cost' ? await this.ledgers.get(run.projectId) : undefined);
      if (reason) {
        run.pending = { callId: call.id, tool: tool.name, risk: tool.risk, arguments: bound(call.arguments, 4000), reason, estimate };
        run.status = 'awaiting_approval'; run.message = `等待批准：${tool.name}（${reason}）`;
        await this.step(run, { kind: 'approval', status: 'pending', tool: tool.name, callId: call.id, risk: tool.risk, arguments: bound(call.arguments, 2000), summary: reason });
        await this.save(run); return 'suspend';
      }
    }
    const step = await this.step(run, { kind: 'tool', status: 'running', tool: tool.name, callId: call.id, risk: tool.risk, arguments: bound(call.arguments, 2000) });
    run.message = '执行工具：' + tool.name; await this.save(run);
    let result: ToolResult;
    try { result = await this.withRetry(run, step, () => tool.run({ ...args, __callId: call.id }, this.context(run.id, run.projectId, signal)), signal); }
    catch (error) {
      if (signal.aborted) throw error;
      const kind = classify(error), message = errorText(error);
      await this.finishStep(run, step, { status: 'failed', error: message });
      chargeTool(run.usage, 0, 'read');
      respond(JSON.stringify({ error: message, hint: kind === 'conflict' ? '工程版本已变化：先调用 project_get 获取最新 revision 再重试' : kind === 'retry' ? '临时故障，已重试多次' : '请修正参数或换一种方法' }));
      await this.save(run); return 'next';
    }
    signal.throwIfAborted();
    chargeTool(run.usage, result.cost, tool.risk); if (tool.risk === 'cost') await this.spend(run.projectId, tool.name, result.waitFor ? null : result.cost);
    if (tool.risk === 'write') meta.dirty = true;
    if (result.images?.length) {
      if (model.vision && meta.allowImages) this.imageBuffer.set(run.id, [...(this.imageBuffer.get(run.id) ?? []), ...result.images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` } }))]);
      else result = { ...result, content: result.content + '（画面已截取；当前模型或设置不允许发送图片，请用 visual_review 或 render_check 检查）' };
    }
    await this.finishStep(run, step, { status: 'complete', summary: bound(result.content, 300) });
    if (result.waitFor) { run.waiting = { ...result.waitFor, callId: call.id }; run.queue.shift(); run.status = 'waiting_task'; run.message = '等待生成任务完成'; await this.save(run); return 'next'; }
    respond(result.content); await this.save(run); return 'next';
  }

  private async awaitTask(run: AgentRun, signal: AbortSignal): Promise<void> {
    const waiting = run.waiting!; const terminal = new Set(['ready', 'complete', 'failed', 'cancelled', 'unknown', 'paused']);
    while (true) {
      signal.throwIfAborted();
      const result = await this.port.route(waiting.kind === 'media' ? 'media.get' : 'workflows.get', waiting.kind === 'media' ? { taskId: waiting.id } : { workflowId: waiting.id });
      const value = (result.value ?? {}) as Record<string, unknown>, state = String(value.phase ?? value.status ?? '');
      if (!result.ok || terminal.has(state) || (waiting.kind === 'workflow' && state !== 'running')) {
        if (waiting.kind === 'media' && value.usage && typeof (value.usage as { cost?: unknown }).cost === 'number') { run.usage.cost += (value.usage as { cost: number }).cost; run.usage.unknownCostCalls = Math.max(0, run.usage.unknownCostCalls - 1); await this.spend(run.projectId, 'media', (value.usage as { cost: number }).cost, true); }
        run.messages.push({ role: 'tool', tool_call_id: waiting.callId, content: bound(JSON.stringify(result.ok ? { id: waiting.id, state, message: value.message, error: value.error, hint: state === 'ready' ? '素材已就绪：调用 media_apply 采用' : undefined } : { error: result.error?.message })) });
        delete run.waiting; run.status = 'running'; run.message = '生成任务已结束'; await this.save(run); return;
      }
      await sleep(this.options.pollMs ?? 1000, signal);
    }
  }
}
