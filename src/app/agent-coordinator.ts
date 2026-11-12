import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentDatabase } from '../agent/database.ts';
import { AgentRepository, agentError, candidateHash, contentHash } from '../agent/repository.ts';
import { AgentRuntime } from '../agent/runtime.ts';
import { AGENT_LIMITS, type AgentCandidatePayload, type AgentDecision, type AgentLease, type AgentRole, type AgentScope, type AgentTask } from '../agent/contracts.ts';
import type { Asset, SceneSource, StudioSnapshot } from '../shared/types.ts';
import type { ModelRole, ResolvedModel } from '../models/contracts.ts';
import type { ChatInput } from './contracts.ts';
import type { AppBackend } from './backend.ts';
import type { ModelMessage, ProviderManager } from './model.ts';
import type { MediaTaskService } from '../jobs/media-tasks.ts';
import { parseSceneSource } from '../host/generator.ts';

type ObjectValue = Record<string, unknown>;
interface FrozenRoute { role: ModelRole; modelId: string; connectionId: string; fingerprint: string; contextChars: number }
interface TaskData extends ObjectValue {
  baseline: AgentCandidatePayload;
  routes: FrozenRoute[];
  allowImageUpload: boolean;
  imageAssetIds: string[];
}
export interface RootToolContext { lease: AgentLease; projectId?: string; snapshot: StudioSnapshot; taskId: string; sessionId: string; request?: ChatInput; toolOperationId?: string }
function record(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw agentError('INVALID_SCOPE', '请提供明确的镜头、字段和工具范围'); return [...new Set(value)] as string[]; }
function routeFingerprint(value: ResolvedModel): string { const { credentialRef: _credentialRef, ...connection } = value.connection; return contentHash({ connection, model: value.model }); }
function taskData(task: AgentTask): TaskData { const data = task.data as TaskData | undefined; if (!data?.baseline?.project || !Array.isArray(data.routes)) throw agentError('BASELINE_REQUIRED', '任务缺少冻结的工程和模型配置'); return data; }
function inScope(scope: AgentScope, id: string): boolean { return scope.shotIds.includes('*') || scope.shotIds.includes(id); }
function readDependencies(baseline: AgentCandidatePayload, scope: AgentScope): Record<string, string> {
  const project = baseline.project, result: Record<string, string> = { target: contentHash(project.target), videoStyle: contentHash(project.videoStyle) };
  for (const shot of project.shots.filter(shot => inScope(scope, shot.id))) {
    result['shot:' + shot.id] = contentHash(shot); result['source:' + shot.id] = contentHash(baseline.sources[shot.id]);
    for (const id of [...shot.assetIds, ...shot.referenceIds]) result['asset:' + id] = contentHash(project.assets.find(asset => asset.id === id));
  }
  for (const field of scope.writeFields.map(field=>field.split('.')[0]!).filter(field=>field==='*'||Object.hasOwn(project,field))) result['field:' + field] = contentHash(field === '*' ? project : record(project)[field]);
  if(scope.capabilities.includes('speech')||scope.writeFields.includes('audioClips'))result.timeline=contentHash({order:project.shotOrder,durations:project.shots.map(shot=>({id:shot.id,frames:shot.durationFrames}))});
  return result;
}
function publicTask(task: AgentTask) { const { data: _data, modelSnapshot: _modelSnapshot, leaseOwner: _leaseOwner, ...result } = task; return result; }
function toolTask(task:AgentTask){return {id:task.id,sessionId:task.sessionId,parentTaskId:task.parentTaskId,status:task.status,generation:task.generation,candidateId:task.candidateId,committedRevision:task.committedRevision,error:task.error?.slice(0,512),summary:task.summary?.slice(0,1024)};}

/** Application-owned identities and ports. A model receives references, never lease tokens or the full project. */
export class AgentCoordinator {
  private repositories = new Map<string, Promise<AgentRepository>>();
  private runtimes = new Map<string, AgentRuntime>();
  constructor(private options: { dataDirectory: string; backend: AppBackend; providers: ProviderManager; media: MediaTaskService; voice(projectId: string, shotId: string, text: string, signal: AbortSignal,selection?:{modelId:string;connectionId:string}): Promise<Asset> }) {}

  repositoryFor = (projectId?: string): Promise<AgentRepository> => {
    const key = projectId ?? '__lobby__'; let pending = this.repositories.get(key);
    if (!pending) { pending = (async () => {
      const snapshot = projectId ? await this.options.backend.call('current', { projectId }) : undefined;
      if (projectId && (snapshot?.project?.id !== projectId || !snapshot.root)) throw agentError('PROJECT_NOT_FOUND', '工程不存在');
      const database = new AgentDatabase(snapshot?.root ? join(snapshot.root, '.studio', 'state.sqlite') : join(this.options.dataDirectory, 'agent-state.sqlite'));
      const repository = new AgentRepository(database, key); await repository.initialize(); return repository;
    })(); this.repositories.set(key, pending); pending.catch(() => this.repositories.delete(key)); }
    return pending;
  };

  private async baseline(projectId: string): Promise<AgentCandidatePayload> {
    const snapshot = await this.options.backend.call('current', { projectId });
    if (!snapshot.project) throw agentError('PROJECT_REQUIRED', '协作需要已经创建的工程');
    const project = snapshot.project, sources: Record<string, SceneSource> = {};
    for (const shot of project.shots) sources[shot.id] = await this.options.backend.call<SceneSource>('source', { projectId, shotId: shot.id, revision: project.revision });
    return { project, sources, baseRevision: project.revision };
  }

  private async frozenRoutes(roles: ModelRole[]): Promise<FrozenRoute[]> {
    return Promise.all([...new Set(roles)].map(async role => {
      const selected = await this.options.providers.registry.resolve(role);
      return { role, modelId: selected.model.id, connectionId: selected.connection.id, fingerprint: routeFingerprint(selected), contextChars: Math.min(AGENT_LIMITS.contextChars, Number(selected.model.parameters.contextCharLimit ?? AGENT_LIMITS.contextChars)) };
    }));
  }
  private async route(task: AgentTask, role: ModelRole): Promise<FrozenRoute> {
    const frozen = taskData(task).routes.find(route => route.role === role);
    if (!frozen) throw agentError('MODEL_SNAPSHOT_MISSING', '本任务未授予该模型能力：' + role);
    let selected: ResolvedModel;
    try { selected = await this.options.providers.registry.resolve({ modelId: frozen.modelId, connectionId: frozen.connectionId }); }
    catch { throw agentError('MODEL_CONFIG_CHANGED', '冻结的模型配置已不可用；请恢复原配置再继续'); }
    if (routeFingerprint(selected) !== frozen.fingerprint) throw agentError('MODEL_CONFIG_CHANGED', '模型配置与任务快照不一致；请恢复原配置再继续');
    return frozen;
  }
  private scoped(task: AgentTask, query: { shotIds?: string[]; fields?: string[]; offset?: number; limit?: number } = {}) {
    const { baseline } = taskData(task), ids = query.shotIds ?? baseline.project.shots.filter(shot => inScope(task.scope, shot.id)).map(shot => shot.id);
    if (ids.some(id => !inScope(task.scope, id))) throw agentError('SCOPE_DENIED', '读取超出授权镜头');
    const allowed = new Set(['title', 'intent', 'composition', 'action', 'durationFrames', 'params', 'assetIds', 'referenceIds', 'narration']);
    if(query.fields?.includes('source')){
      if(ids.length!==1)throw agentError('READ_PAGE_SCOPE','源码分页一次只能读取一个镜头');const source=baseline.sources[ids[0]!],serialized=JSON.stringify(source),offset=query.offset??0,limit=Math.min(query.limit??1600,2500);
      return {revision:baseline.baseRevision,shotId:ids[0],sha256:contentHash(source),offset,totalChars:serialized.length,nextOffset:offset+limit<serialized.length?offset+limit:null,sourcePage:serialized.slice(offset,offset+limit)};
    }
    if(query.fields?.includes('diff')){const current=record(task.data?.runtime).candidate as AgentCandidatePayload|undefined;return {baseRevision:baseline.baseRevision,changedShots:current?ids.filter(id=>contentHash(current.sources[id])!==contentHash(baseline.sources[id])||contentHash(current.project.shots.find(shot=>shot.id===id))!==contentHash(baseline.project.shots.find(shot=>shot.id===id))):[]};}
    const fields = query.fields ?? [...allowed]; if (fields.some(field => !allowed.has(field))) throw agentError('SCOPE_DENIED', '该字段不属于授权范围');
    const shots = baseline.project.shots.filter(shot => ids.includes(shot.id)).map(shot => ({ id: shot.id, ...Object.fromEntries(fields.map(field => [field, record(shot)[field]])) }));
    const assets = baseline.project.assets.filter(asset => baseline.project.shots.some(shot => ids.includes(shot.id) && [...shot.assetIds, ...shot.referenceIds].includes(asset.id))).map(({ id, kind, name, description, width, height, duration, sha256 }) => ({ id, kind, name, description, width, height, duration, sha256 }));
    return { revision: baseline.baseRevision, target: baseline.project.target, videoStyle: baseline.project.videoStyle, shots, assets };
  }
  private lease(task:AgentTask):AgentLease{if(!task.leaseOwner||!task.leaseExpiresAt)throw agentError('LEASE_REQUIRED','任务缺少执行租约');return {taskId:task.id,sessionId:task.sessionId,projectId:task.projectId,generation:task.generation,leaseOwner:task.leaseOwner,leaseExpiresAt:task.leaseExpiresAt};}
  private async visualInput(repository:AgentRepository,task:AgentTask,candidate:AgentCandidatePayload,signal:AbortSignal){
    if(!taskData(task).allowImageUpload)throw agentError('IMAGE_UPLOAD_DENIED','视觉验收需要本次任务明确允许上传实际关键帧');
    const route=await this.route(task,'vision'),settings=await this.options.providers.settings({modelId:route.modelId,connectionId:route.connectionId});
    const shots=candidate.project.shots.filter(shot=>inScope(task.scope,shot.id));if(!shots.length||shots.length>(settings.config.maxVisionImages??3))throw agentError('VISION_SCOPE_LIMIT','视觉验收镜头数量超出模型图片预算，请拆分任务');
    await repository.reserveBudget(this.lease(task),{toolCalls:1});
    const frames:{frame:number;sha256:string}[]=[],images:{type:'image_url';image_url:{url:string}}[]=[];let cursor=0;
    for(const id of candidate.project.shotOrder){const shot=candidate.project.shots.find(shot=>shot.id===id)!;if(inScope(task.scope,shot.id)){const frame=cursor+Math.floor(shot.durationFrames/2),image=await this.options.backend.workflowCapture(task.projectId,frame,signal,{project:candidate.project,sources:candidate.sources});frames.push({frame,sha256:image.sha256});images.push({type:'image_url',image_url:{url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}});}cursor+=shot.durationFrames;}
    await repository.assertLease(this.lease(task));
    await repository.database.transaction([{sql:'CREATE TABLE IF NOT EXISTS agent_visual_evidence(task_id TEXT NOT NULL,generation INTEGER NOT NULL,candidate_hash TEXT NOT NULL,frames_json TEXT NOT NULL,PRIMARY KEY(task_id,generation,candidate_hash))'},{sql:'INSERT OR REPLACE INTO agent_visual_evidence VALUES(?,?,?,?)',params:[task.id,task.generation,candidateHash(candidate),JSON.stringify(frames)]}]);
    return {images,frames,hash:candidateHash(candidate)};
  }
  private async runtime(projectId: string): Promise<AgentRuntime> {
    let runtime = this.runtimes.get(projectId); if (runtime) return runtime;
    const repository = await this.repositoryFor(projectId);
    runtime = this.runtimes.get(projectId); if(runtime)return runtime;
    runtime = new AgentRuntime(repository, {
      preflight: async task => { for (const route of taskData(task).routes) await this.route(task, route.role); if (task.data?.maxCost !== undefined) throw agentError('COST_UNKNOWN', '无法可靠预估模型费用，不能执行设有金额硬上限的任务'); },
      context: async task => ({ goal: task.goal, constraints: task.scope, acceptance: task.acceptance ?? [], project: this.scoped(task), dependencies: await Promise.all((task.dependencies ?? []).map(async id => { const candidate = await repository.getCandidate(id); if (candidate.status !== 'accepted') throw agentError('DEPENDENCY_PENDING', '依赖尚未验收'); return { id, hash: candidate.hash, summary: candidate.summary }; })), budget: await repository.getBudget(task.rootTaskId) }),
      text: async ({ task, role, messages, system, signal }) => {
        const route = await this.route(task, role); const size = system.length + messages.reduce((total, message) => total + message.content.length, 0); if (size > route.contextChars) throw agentError('CONTEXT_BUDGET', '硬约束与上下文超过模型预算，请缩小任务范围');
        const request:ModelMessage[]=structuredClone(messages);
        if(role==='vision'){const evidence=await this.visualInput(repository,task,taskData(task).baseline,signal);request.push({role:'user',content:[{type:'text',text:JSON.stringify({candidateHash:evidence.hash,frames:evidence.frames,instruction:'先read确认授权范围，然后submit.evidence必须为{verdict:"pass"或"fail",candidateHash,findings:[]}。负面结论不能申请通过。'})},...evidence.images]});}
        return this.options.providers.complete(request, system, signal, undefined, { modelId: route.modelId, connectionId: route.connectionId }, task.sessionId);
      },
      inspect: async (task, query) => {
        if (query.taskId) { const target = await repository.getTask(query.taskId); if (target.id !== task.id) throw agentError('SCOPE_DENIED', '成员不能读取其他成员上下文'); return publicTask(target); }
        if (query.candidateId) { if (!(task.dependencies ?? []).includes(query.candidateId)) throw agentError('SCOPE_DENIED', '未授权的依赖产物'); const candidate = await repository.getCandidate(query.candidateId); if (candidate.status !== 'accepted') throw agentError('DEPENDENCY_PENDING', '依赖尚未验收'); return { id: candidate.id, hash: candidate.hash, summary: candidate.summary }; }
        return this.scoped(task, query);
      },
      execute: (task, action, operationId, lease, signal) => this.execute(repository, task, action, operationId, lease, signal),
      validate: async (task, candidate, signal) => {
        const receipt=await this.options.backend.validateCandidate(task.projectId, { project: candidate.payload.project, sources: candidate.payload.sources }, signal);
        if(receipt.status!=='passed')return receipt;
        const visual=task.role==='vision'||(task.acceptance??[]).some(value=>/视觉|审片|visual/i.test(value));
        if(visual){
          let verdict=record(record(task.data?.runtime).evidence);
          if(task.role!=='vision'){
            const operationId=task.id+':visual:'+candidate.hash.slice(0,24),lease=this.lease(task),prior=await repository.getOperation(operationId);
            if(prior){if(prior.status!=='complete')throw agentError('RECONCILIATION_REQUIRED','视觉模型请求结果未知，不能重复调用');verdict=record(prior.result);}
            else{await repository.reserveBudget(lease,{modelCalls:1});await repository.beginOperation(lease,operationId,{candidateHash:candidate.hash,acceptance:task.acceptance});
              try{const input=await this.visualInput(repository,task,candidate.payload,signal),route=await this.route(task,'vision'),response=await this.options.providers.complete([{role:'user',content:[{type:'text',text:JSON.stringify({goal:task.goal,acceptance:task.acceptance,candidateHash:candidate.hash,frames:input.frames})},...input.images]}],'依据实际关键帧审片。只返回JSON {verdict:"pass"或"fail",candidateHash,findings:[]}；有任何不满足的验收条件必须fail。',signal,undefined,{modelId:route.modelId,connectionId:route.connectionId},task.sessionId);verdict=record(JSON.parse(response));await repository.finishOperation(lease,operationId,'complete',verdict);}
              catch(error){await repository.finishOperation(lease,operationId,'unknown',undefined,error instanceof Error?error.message:String(error)).catch(()=>{});throw error;}
            }
          }
          const rows=await repository.database.query<{frames_json:string}>('SELECT frames_json FROM agent_visual_evidence WHERE task_id=? AND generation=? AND candidate_hash=?',[task.id,task.generation,candidate.hash]);
          const passed=verdict.verdict==='pass'&&verdict.candidateHash===candidate.hash&&Array.isArray(verdict.findings)&&rows.length===1;
          receipt.checks.push({id:'visual-verdict',status:passed?'passed':'failed',message:JSON.stringify(verdict).slice(0,2000)});if(!passed)receipt.status='failed';
        }
        return receipt;
      },
    }); this.runtimes.set(projectId, runtime); return runtime;
  }

  private async execute(repository: AgentRepository, task: AgentTask, action: Extract<AgentDecision, { type: 'execute' }>, operationId: string, lease: AgentLease, signal: AbortSignal) {
    await repository.assertLease(lease); signal.throwIfAborted();
    const data = taskData(task), prior = record(task.data?.runtime).candidate as AgentCandidatePayload | undefined, candidate = structuredClone(prior ?? data.baseline), shot = candidate.project.shots.find(shot => shot.id === action.shotId);
    if (!shot || !inScope(task.scope, shot.id)) throw agentError('SCOPE_DENIED', '动作必须指定已授权镜头');
    if (!task.scope.capabilities.includes(action.tool)) throw agentError('TOOL_DENIED', '任务未授予该工具');
    if (action.tool === 'code') {
      const source = parseSceneSource(JSON.stringify(action.input.source ?? action.input));
      if (source.shotPatch) Object.assign(shot, source.shotPatch);
      candidate.sources[shot.id] = { html: source.html, css: source.css, js: source.js };
      return { summary: '已生成镜头源码候选：' + shot.id, candidate };
    }
    await this.route(task, action.tool); await repository.reserveBudget(lease, { modelCalls: 1 });
    if (action.tool === 'speech') {
      const text = String(action.input.text ?? shot.narration ?? '').trim(); if (!text) throw agentError('TEXT_REQUIRED', '语音任务缺少朗读文本');
      const route=await this.route(task,'speech'),asset = await this.options.voice(task.projectId, shot.id, text, signal,{modelId:route.modelId,connectionId:route.connectionId}); await repository.assertLease(lease);
      candidate.project.assets.push(asset); shot.assetIds = [...new Set([...shot.assetIds, asset.id])]; shot.narration = text;
      const fps = candidate.project.target.fps.num / candidate.project.target.fps.den;
      const startSeconds = candidate.project.shotOrder.slice(0, candidate.project.shotOrder.indexOf(shot.id)).reduce((sum, id) => sum + candidate.project.shots.find(shot=>shot.id===id)!.durationFrames / fps, 0);
      candidate.project.audioClips = [...(candidate.project.audioClips ?? []).filter(clip => clip.shotId !== shot.id || clip.role !== 'voice'), { id: 'agent-' + operationId, assetId: asset.id, role: 'voice', shotId: shot.id, startSeconds, trimStart: 0, volume: 1, fadeIn: 0, fadeOut: 0 }];
      candidate.project.target.audioMode = 'mixed';
      return { summary: '已生成语音候选：' + shot.id, candidate, artifactRefs: [asset.id] };
    }
    const route = await this.route(task, action.tool), prompt = String(action.input.prompt ?? '').trim(); if (!prompt) throw agentError('PROMPT_REQUIRED', '生成素材缺少提示词');
    const imageAssetIds = action.input.imageAssetIds === undefined ? [] : strings(action.input.imageAssetIds);
    if (imageAssetIds.some(id => !data.imageAssetIds.includes(id)) || imageAssetIds.length && !data.allowImageUpload) throw agentError('IMAGE_UPLOAD_DENIED', '素材上传未获得本次任务授权');
    let media = await this.options.media.generate({ projectId: task.projectId, shotId: shot.id, expectedRevision: candidate.baseRevision, clientRequestId: operationId, operation: action.tool === 'image' ? 'text-to-image' : imageAssetIds.length ? 'image-to-video' : 'text-to-video', prompt, modelId: route.modelId, connectionId: route.connectionId, imageAssetIds, allowImageUpload: data.allowImageUpload, ownerSessionId: task.sessionId });
    while (!['ready', 'complete', 'failed', 'cancelled', 'unknown'].includes(media.phase)) { await delay(250, undefined, { signal }); await repository.assertLease(lease); media = await this.options.media.get(media.id); if (media.observation === 'paused') throw agentError('REMOTE_PENDING', '远端任务已暂停观察，保留原请求：' + media.id); }
    if (!['ready', 'complete'].includes(media.phase)) throw agentError(media.phase === 'unknown' ? 'REMOTE_PENDING' : 'MEDIA_FAILED', media.message + '；原请求：' + media.id);
    const files = await this.options.media.prepare(media.id), assets = await this.options.backend.stageWorkflowMedia(task.projectId, media, files, signal); await repository.assertLease(lease);
    candidate.project.assets.push(...assets); shot.assetIds = [...new Set([...shot.assetIds, ...assets.map(asset => asset.id)])];
    if (action.tool === 'video') { const asset = assets.find(asset => asset.kind === 'video'); if (asset) candidate.project.videoClips = [...(candidate.project.videoClips ?? []).filter(clip => clip.shotId !== shot.id), { id: 'agent-' + operationId, shotId: shot.id, assetId: asset.id, trimStart: 0, speed: 1, fit: 'cover', audio: 'mute' }]; }
    return { summary: '已生成素材候选：' + shot.id, candidate, artifactRefs: assets.map(asset => asset.id), remoteTaskId: media.id };
  }

  externalTool = async (tool: string, args: ObjectValue, context: RootToolContext, signal: AbortSignal): Promise<unknown> => {
    if (!context.projectId) throw agentError('PROJECT_REQUIRED', '请先创建工程再委派成员');
    const repository = await this.repositoryFor(context.projectId), parent = await repository.assertLease(context.lease), runtime = await this.runtime(context.projectId);
    if (parent.parentTaskId || parent.id !== context.taskId || parent.sessionId !== context.sessionId) throw agentError('DELEGATION_DENIED', '只有真实根任务执行者可以委派或验收');
    if (tool === 'agent_delegate') {
      if(context.toolOperationId){
        const identity=contentHash({parent:parent.id,operationId:context.toolOperationId}).slice(0,40);
        try{const existing=await repository.getTask('agent-task-'+identity);if(existing.parentTaskId!==parent.id||existing.data?.delegationRequestHash!==contentHash(args))throw agentError('OPERATION_MISMATCH','委派操作对应不同请求');return {receipt:toolTask(existing)};}catch(error){if((error as {code?:string}).code!=='TASK_NOT_FOUND')throw error;}
      }
      const baseline = await this.baseline(context.projectId);
      if (baseline.baseRevision !== context.snapshot.project?.revision) throw agentError('REVISION_CONFLICT', '工程已变化，请先处理版本冲突再委派');
      const role = String(args.role ?? 'scene') as AgentRole; if (!['director', 'scene', 'vision'].includes(role)) throw agentError('INVALID_ROLE', '无效的成员角色');
      const scope: AgentScope = { shotIds: strings(args.shotIds), writeFields: args.writeFields === undefined ? role === 'vision' ? [] : ['source'] : strings(args.writeFields), capabilities: args.capabilities === undefined ? role === 'vision' ? [] : ['code'] : strings(args.capabilities) };
      if (!scope.shotIds.length || scope.shotIds.includes('*') || scope.shotIds.some(id => !baseline.project.shots.some(shot => shot.id === id))) throw agentError('SCOPE_DENIED', '委派必须指定已有镜头，不能授权整个工程');
      const acceptance=args.acceptance===undefined?[]:strings(args.acceptance);
      const roles: ModelRole[] = [role, ...scope.capabilities.filter((value): value is 'image' | 'video' | 'speech' => ['image', 'video', 'speech'].includes(value)),...(acceptance.some(value=>/视觉|审片|visual/i.test(value))?['vision' as const]:[])];
      const routes = await this.frozenRoutes(roles); baseline.readSet = readDependencies(baseline, scope);
      const task = await runtime.delegate({ parentTaskId: parent.id, parentLease: context.lease, operationId: context.toolOperationId, mode: args.mode === 'team' ? 'team' : 'subagent', sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined, goal: String(args.goal ?? ''), name: typeof args.name === 'string' ? args.name : undefined, role, scope, dependencies: args.dependencies === undefined ? [] : strings(args.dependencies), acceptance, modelSnapshot: routes, data: { baseline, routes, delegationRequestHash:contentHash(args), allowImageUpload: context.request?.allowImageUpload === true, imageAssetIds: context.request?.imageAssetIds ?? [], ...(args.maxCost === undefined ? {} : { maxCost: args.maxCost }) } }, signal);
      return { receipt: toolTask(task) };
    }
    if (tool === 'agent_accept') {
      const candidate = await repository.getCandidate(String(args.candidateId)), child = await repository.getTask(candidate.taskId);
      if (child.parentTaskId !== parent.id) throw agentError('ACCEPTANCE_DENIED', '不能验收其他根任务的产物');
      const current = await this.baseline(context.projectId), previous = taskData(child).baseline;
      if (contentHash(readDependencies(current, child.scope)) !== contentHash(previous.readSet)) throw agentError('REVISION_CONFLICT', '候选读取或修改范围已变化，请重新委派并验证');
      // Unrelated changes are preserved. Even with matching dependencies, the merged candidate is validated again by the root loop.
      const merged = {...structuredClone(current),sources:{} as Record<string,SceneSource>};
      for (const shot of candidate.payload.project.shots) if (contentHash(shot) !== contentHash(previous.project.shots.find(item => item.id === shot.id))) { const index = merged.project.shots.findIndex(item => item.id === shot.id); if (index < 0) throw agentError('REVISION_CONFLICT', '目标镜头已不存在'); merged.project.shots[index] = shot; }
      for (const [id, source] of Object.entries(candidate.payload.sources)) if (contentHash(source) !== contentHash(previous.sources[id])) merged.sources[id] = source;
      for (const key of Object.keys(candidate.payload.project)) if (key !== 'shots' && contentHash(record(candidate.payload.project)[key]) !== contentHash(record(previous.project)[key])) record(merged.project)[key] = record(candidate.payload.project)[key];
      await runtime.accept(context.lease, candidate.id);
      return { receipt: { candidateId: candidate.id, taskId: child.id, status: 'accepted', summary: candidate.summary, hash: candidate.hash }, acceptedCandidate: merged, snapshot:{...context.snapshot,project:current.project} };
    }
    const child = await repository.getTask(String(args.taskId)); if (child.parentTaskId !== parent.id) throw agentError('SCOPE_DENIED', '只能访问当前根任务委派的成员');
    if (tool === 'agent_wait') return { receipt: toolTask(await runtime.wait(child.id, { timeoutMs: 90_000, signal })) };
    if (tool === 'agent_result') return { receipt: { task: toolTask(await repository.getTask(child.id)), candidates: (await repository.listCandidates(child.id)).slice(-2).map(({ id, hash, summary, status, validationId }) => ({ id, hash, summary:summary.slice(0,512), status, validationId })), messages:(await repository.messages(child.id)).slice(-4) } };
    if (tool === 'agent_cancel') return { receipt: toolTask(await runtime.cancelChild(context.lease,child.id,child.generation)) };
    throw agentError('UNKNOWN_TOOL', '未授权的协作工具');
  };

  async tasks(projectId?: string, sessionId?: string) {
    const repository = await this.repositoryFor(projectId), all = await repository.listTasks();
    if (sessionId) await repository.getSession(sessionId);
    const roots = new Set(all.filter(task => !sessionId || task.sessionId === sessionId).map(task => task.rootTaskId));
    const tasks = all.filter(task => roots.has(task.rootTaskId));
    return { tasks: tasks.map(publicTask), budgets: Object.fromEntries(await Promise.all([...roots].map(async id => [id, await repository.getBudget(id)]))) };
  }
  async control(action: string, input: ObjectValue) {
    const projectId = String(input.projectId), repository = await this.repositoryFor(projectId), runtime = await this.runtime(projectId);
    const task = await repository.getTask(String(input.taskId)), root = await repository.getTask(task.rootTaskId);
    if (!task.parentTaskId || root.sessionId !== input.sessionId) throw agentError('CONTROL_DENIED', '任务不属于当前根会话');
    const control = { sessionId: String(input.sessionId), expectedGeneration: Number(input.generation) };
    if (action === 'pause') return publicTask(await runtime.pause(task.id, control));
    if (action === 'cancel') return publicTask(await runtime.cancel(task.id, control));
    if (action === 'resume' || action === 'retry') return publicTask(await runtime.resume(task.id, control));
    throw agentError('INVALID_CONTROL', '无效的任务控制动作');
  }
  async dispose() { for (const runtime of this.runtimes.values()) await runtime.dispose(); for (const pending of this.repositories.values()) await (await pending).database.close(); }
}
