import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRepository, contentHash, stableJson } from '../agent/repository.ts';
import { AGENT_LIMITS, type AgentCandidatePayload, type AgentLease, type AgentSession, type AgentTask, type AgentTaskPatch, type ValidationReceipt } from '../agent/contracts.ts';
import type { StudioSnapshot } from '../shared/types.ts';
import type { BackendPort, ChatInput, Conversation, ConversationExecution } from './contracts.ts';
import { ConversationService, selectedShots, validateChatInput, inferIntent } from './conversation.ts';
import { ProviderManager } from './model.ts';

export interface ConversationToolContext { lease:AgentLease; projectId?:string; snapshot:StudioSnapshot; taskId:string; sessionId:string; request:ChatInput; toolOperationId:string }
export interface ConversationSessionsOptions {
  backend:BackendPort;providers:ProviderManager;dataDirectory:string;
  repositoryFor(projectId?:string):Promise<AgentRepository>;
  externalTool?(tool:string,args:Record<string,unknown>,context:ConversationToolContext,signal:AbortSignal):Promise<unknown>;
}
const error=(code:string,message:string)=>Object.assign(new Error(message),{code});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const conversationData=(value:unknown):value is Conversation=>!!value&&typeof value==='object'&&Array.isArray((value as Conversation).messages)&&typeof (value as Conversation).id==='string';
const terminal=new Set(['succeeded','failed','cancelled']);

/** Durable session routing, with one leased task per session across app processes. */
export class ConversationSessions {
  private owner='app-'+randomUUID();
  private active=new Map<string,{service:ConversationService;taskId:string;generation:number;projectId?:string;promise:Promise<unknown>}>();
  private locating?:Promise<AgentRepository>;private stopped=false;
  constructor(private options:ConversationSessionsOptions){}
  hasActiveTurn():boolean{return this.active.size>0;}
  private locations(){return this.locating??=(async()=>{const repo=await this.options.repositoryFor();await repo.initialize();await repo.database.transaction([{sql:'CREATE TABLE IF NOT EXISTS session_locations(session_id TEXT PRIMARY KEY,project_id TEXT,updated_at TEXT NOT NULL)'},{sql:'CREATE TABLE IF NOT EXISTS conversation_create_outbox(operation_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,task_id TEXT NOT NULL,target_project_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,committed_revision INTEGER,updated_at TEXT NOT NULL)'}]);return repo;})();}
  private async locate(sessionId:string,projectId?:string){
    if(!sessionId?.trim())throw error('SESSION_REQUIRED','请选择会话');
    await this.recoverCreation(sessionId);const lobby=await this.locations(),rows=await lobby.database.query<{project_id:string|null}>('SELECT project_id FROM session_locations WHERE session_id=?',[sessionId]);
    const known=rows[0]?.project_id??undefined;if(projectId&&known&&projectId!==known)throw error('SESSION_SCOPE_VIOLATION','会话属于另一工程');
    const resolved=projectId??known,repository=await this.options.repositoryFor(resolved);await repository.initialize();
    const session=await repository.getSession<Conversation>(sessionId);await this.remember(sessionId,resolved);return {repository,session,projectId:resolved};
  }
  private async remember(sessionId:string,projectId?:string){const lobby=await this.locations();await lobby.database.transaction([{sql:'INSERT INTO session_locations(session_id,project_id,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=COALESCE(excluded.project_id,session_locations.project_id),updated_at=excluded.updated_at',params:[sessionId,projectId??null,new Date().toISOString()]}]);}
  private async transferCreation(source:AgentRepository,targetProjectId:string,sessionId:string,taskId:string,revision:number,conversation?:Conversation){
    const target=await this.options.repositoryFor(targetProjectId);await target.initialize();const now=new Date().toISOString(),statements:{sql:string;params?:unknown[]}[]=[];
    const specs=[['agent_sessions','id',sessionId],['agent_tasks','id',taskId],['agent_grants','task_id',taskId],['agent_budget','root_task_id',taskId],['agent_operations','task_id',taskId],['session_activity','session_id',sessionId]];
    for(const [table,key,id]of specs){for(const original of await source.database.query<Record<string,unknown>>(`SELECT * FROM ${table} WHERE ${key}=?`,[id])){
      const row={...original};if('project_id'in row)row.project_id=targetProjectId;
      if(table==='agent_sessions'){const data=conversation??JSON.parse(String(row.data_json)) as Conversation;row.data_json=stableJson({...data,projectId:targetProjectId});}
      if(table==='agent_operations'){row.status='complete';row.result_json=stableJson({committedRevision:revision});row.error=null;}
      if(table==='agent_tasks'){const data=JSON.parse(String(row.data_json)) as AgentTask;row.data_json=stableJson({...data,projectId:targetProjectId,committedRevision:revision,checkpoint:'needs-validation'});row.committed_revision=revision;row.status='reconciling';}
      const columns=Object.keys(row);statements.push({sql:`INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,params:columns.map(column=>row[column])});
    }}
    await target.database.transaction(statements);await this.remember(sessionId,targetProjectId);
    await source.database.transaction([{sql:"UPDATE conversation_create_outbox SET state='migrated',committed_revision=?,updated_at=? WHERE task_id=?",params:[revision,now,taskId]},{sql:"UPDATE agent_tasks SET status='paused',lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=?",params:[taskId]},{sql:'UPDATE agent_grants SET revoked=1 WHERE task_id=?',params:[taskId]},{sql:'DELETE FROM session_activity WHERE session_id=? AND task_id=?',params:[sessionId,taskId]}]);
    return {repository:target,session:await target.getSession<Conversation>(sessionId),task:await target.getTask(taskId)};
  }
  private async recoverCreation(sessionId:string){
    const lobby=await this.locations(),[outbox]=await lobby.database.query<{operation_id:string;task_id:string;target_project_id:string;state:string}>('SELECT * FROM conversation_create_outbox WHERE session_id=? AND state<>?', [sessionId,'migrated']);if(!outbox)return;
    const task=await lobby.getTask(outbox.task_id);if(task.leaseExpiresAt&&task.leaseExpiresAt>Date.now())return;
    let receipt:{committedRevision:number}|undefined;try{receipt=await this.options.backend.call('operation.get',{projectId:outbox.target_project_id,operationId:outbox.operation_id});}catch(failure){if(['PROJECT_NOT_FOUND','ENOENT'].includes((failure as {code?:string}).code??''))return;throw failure;}
    if(receipt){const moved=await this.transferCreation(lobby,outbox.target_project_id,sessionId,task.id,receipt.committedRevision);await moved.repository.controlTask(task.id,'pause',{sessionId,expectedGeneration:moved.task.generation});}
  }
  async create(input:{projectId?:string;name?:string}={}){
    const repository=await this.options.repositoryFor(input.projectId);await repository.initialize();
    const id=randomUUID(),settings=await this.options.providers.settings(),conversation:Conversation={id:randomUUID(),sessionId:id,schemaVersion:2,projectId:input.projectId,messages:[],turns:[],provider:settings.route?.provider??'custom',model:settings.config.model};
    const session=await repository.createSession({id,name:input.name??'新会话',kind:'root',data:conversation});await this.remember(id,input.projectId);return session;
  }
  private async migrateLegacy(repository:AgentRepository,projectId?:string){
    const filename=join(this.options.dataDirectory,'conversations',digest(projectId??'unbound')+'.json');let value:unknown;
    try{value=JSON.parse(await readFile(filename,'utf8'));}catch(failure){if((failure as NodeJS.ErrnoException).code==='ENOENT')return;throw failure;}
    if(!conversationData(value)||value.projectId!==projectId)throw error('LEGACY_CONVERSATION_INVALID','历史对话格式或工程身份不一致');
    const id='legacy-'+digest(value.id+'|'+(projectId??'unbound')).slice(0,40),conversation=structuredClone(value);conversation.sessionId=id;conversation.schemaVersion=2;
    for(const turn of conversation.turns??[]){turn.legacy=true;turn.operationId??='legacy-'+digest(turn.id).slice(0,32);turn.request={...turn.request,sessionId:id,operationId:turn.operationId,expectedRevision:projectId?turn.committedRevision??0:null};if(turn.status==='pending'){turn.status='interrupted';turn.error='旧版运行已中断；历史动作不会自动重放';}if(turn.committedRevision!==undefined&&turn.status!=='succeeded')turn.phase='reconciling';}
    for(const item of conversation.messages){const turn=conversation.turns?.find(turn=>turn.id===item.turnId);if(turn)item.status=turn.status;}
    await repository.createSession({id,name:'历史会话',kind:'root',data:conversation});await this.remember(id,projectId);
  }
  async list(input:{projectId?:string}={}){
    const lobby=await this.locations(),pending=await lobby.database.query<{session_id:string}>('SELECT session_id FROM conversation_create_outbox WHERE state<>?'+(input.projectId?' AND target_project_id=?':''),input.projectId?['migrated',input.projectId]:['migrated']);for(const item of pending)await this.recoverCreation(item.session_id);
    const repository=await this.options.repositoryFor(input.projectId);await repository.initialize();await this.migrateLegacy(repository,input.projectId);
    let sessions=await repository.listSessions();if(!input.projectId){const moved=new Set((await lobby.database.query<{session_id:string}>('SELECT session_id FROM session_locations WHERE project_id IS NOT NULL')).map(row=>row.session_id));sessions=sessions.filter(session=>!moved.has(session.id));}for(const session of sessions)await this.remember(session.id,input.projectId);return sessions;
  }
  async history(input:{sessionId:string;projectId?:string}):Promise<Conversation>{
    const {repository,session}=await this.locate(input.sessionId,input.projectId);if(!conversationData(session.data))throw error('SESSION_HISTORY_UNAVAILABLE','此成员会话没有用户对话记录');
    const result=structuredClone(session.data),tasks=await repository.listTasks({sessionId:session.id});
    for(const turn of result.turns??[]){const task=tasks.find(task=>task.id===turn.taskId);if(task){turn.phase=task.status;turn.committedRevision=task.committedRevision??turn.committedRevision;if(turn.status==='pending'&&(!task.leaseExpiresAt||task.leaseExpiresAt<=Date.now())){turn.status='interrupted';turn.error='上次执行已失去租约，请继续原任务';}}}
    return result;
  }
  async status(input:{sessionId:string;projectId?:string}){const {repository,session}=await this.locate(input.sessionId,input.projectId);return {session,tasks:await repository.listTasks({sessionId:session.id}),activity:this.active.get(session.id)?.service.activity()??{running:false,sessionId:session.id}};}
  async cancel(input:{sessionId:string;projectId?:string;taskId:string;generation:number}){
    return this.control('cancel',input);
  }
  async control(action:'pause'|'cancel'|'resume'|'retry',input:{sessionId:string;projectId?:string;taskId:string;generation:number;expectedRevision?:number|null;operationId?:string}){
    if(!input.taskId||!Number.isSafeInteger(input.generation))throw error('TASK_CONTROL_CONTEXT_REQUIRED','任务控制需要 taskId 和 generation');
    const {repository,session,projectId}=await this.locate(input.sessionId,input.projectId),before=await repository.getTask(input.taskId);
    if(before.sessionId!==session.id)throw error('TASK_SCOPE_VIOLATION','任务不属于此会话');
    if(action==='resume'||action==='retry'){
      if(!Object.hasOwn(input,'expectedRevision')||projectId&&input.expectedRevision===null)throw error('REVISION_REQUIRED','继续任务需要当前 expectedRevision');
      const history=await this.history({sessionId:session.id,projectId}),turn=[...(history.turns??[])].reverse().find(turn=>turn.taskId===before.id);if(!turn)throw error('TURN_NOT_FOUND','任务缺少可恢复的用户回合');
      const expectedModel=await this.options.providers.registry.resolve(turn.request.role??{provider:turn.request.provider,model:turn.request.model});if(before.modelSnapshot&&contentHash(before.modelSnapshot)!==contentHash(expectedModel))throw error('MODEL_SNAPSHOT_CHANGED','任务模型配置已改变，请恢复原配置或新建任务');
      await repository.controlTask(before.id,'resume',{sessionId:session.id,expectedGeneration:input.generation});
      const old=this.active.get(session.id);if(old&&old.taskId===before.id){old.service.cancel();await old.promise.catch(()=>{});}
      return this.send({...turn.request,sessionId:session.id,projectId,expectedRevision:input.expectedRevision!,operationId:input.operationId??randomUUID(),message:'',retryTurnId:turn.id});
    }
    const task=await repository.controlTask(before.id,action,{sessionId:session.id,expectedGeneration:input.generation});
    const active=this.active.get(session.id);if(active&&active.taskId===before.id&&active.generation===input.generation)active.service.cancel();
    return {task,sessionId:session.id};
  }

  async send(input:ChatInput):Promise<{conversation:Conversation;snapshot:StudioSnapshot}>{
    validateChatInput(input);if(this.stopped)throw error('APP_SHUTTING_DOWN','应用正在关闭');if(this.active.has(input.sessionId))throw error('SESSION_BUSY','此会话已有任务运行');
    const requestHash=contentHash(input);
    let {repository,session,projectId}=await this.locate(input.sessionId,input.projectId);input={...input,projectId};if(session.kind!=='root')throw error('ROOT_SESSION_REQUIRED','只能向根会话提交用户请求');
    if(!conversationData(session.data))throw error('SESSION_HISTORY_UNAVAILABLE','会话记录格式无效');
    const history=await this.history({sessionId:session.id,projectId}),retry=input.retryTurnId?history.turns?.find(turn=>turn.id===input.retryTurnId):undefined;
    if(input.retryTurnId&&!retry)throw error('TURN_NOT_FOUND','重试回合不存在');
    const prior=history.turns?.find(turn=>turn.operationId===input.operationId);if(prior&&(prior.requestHash??contentHash(prior.request))!==requestHash)throw error('OPERATION_MISMATCH','同一 operationId 对应不同请求');if(prior?.status==='succeeded')return {conversation:history,snapshot:await this.options.backend.call('current',projectId?{projectId}:{})};
    if(prior&&!input.retryTurnId)throw error('OPERATION_ALREADY_RECORDED','此操作已受理，请继续原任务');
    let snapshot=await this.options.backend.call<StudioSnapshot>('current',projectId?{projectId}:{});if(!projectId)snapshot={...snapshot,project:null,root:null,task:null,previewUrl:null,previewRevision:null};
    if(projectId&&snapshot.project?.revision!==input.expectedRevision)throw error('REVISION_CONFLICT','工程版本已变化，请刷新后重试');
    const request=retry?{...retry.request,...input,message:input.message.trim()||retry.request.message}:input;
    const scopeShots=snapshot.project?selectedShots(snapshot.project,request).map(shot=>shot.id):[];const readOnly=['chat','discuss'].includes(inferIntent(request,!!snapshot.project?.shots.length));const structural=request.intent==='create'||/(?:添加|增加|插入|新增|删除|移除|重排|顺序|交换|重新安排|重做)/.test(request.message);
    const modelSnapshot=await this.options.providers.registry.resolve(request.role??{provider:request.provider,model:request.model});
    let task:AgentTask;
    if(retry?.taskId){task=await repository.getTask(retry.taskId);if(task.status==='cancelled')throw error('TASK_CANCELLED','已取消任务不会自动重新授权；请新建明确的制作请求');}
    else task=await repository.createTask({id:'turn-'+digest(input.sessionId+'|'+input.operationId).slice(0,40),operationId:input.operationId,sessionId:input.sessionId,goal:request.message,role:input.role??'director',scope:{shotIds:scopeShots.length&&!structural?scopeShots:['*'],writeFields:readOnly?[]:['*'],capabilities:readOnly?['read','validate','spawn']:['read','code','image','video','speech','validate','spawn','commit']},modelSnapshot,data:{request:structuredClone(request)}});
    if(task.modelSnapshot&&contentHash(task.modelSnapshot)!==contentHash(modelSnapshot))throw error('MODEL_SNAPSHOT_CHANGED','任务模型配置已改变，请恢复原配置或新建任务');
    if(task.sessionId!==session.id)throw error('TASK_SCOPE_VIOLATION','任务不属于此会话');
    let lease=await repository.claimTask(task.id,this.owner),finished=false,heartbeatRunning=false;let currentOperation:string|undefined;let toolSequence=0;
    const save=async(conversation:Conversation)=>{if(projectId)conversation.projectId=projectId;const latest=await repository.getSession<Conversation>(session.id);if(latest.version!==session.version)throw error('SESSION_VERSION_CONFLICT','会话记录已由另一个执行者修改');session=await repository.saveSessionData(session.id,conversation,session.version);};
    const execution:ConversationExecution={taskId:task.id,lease,requestHash,
      load:async()=>{const value=structuredClone(session.data);for(const turn of value.turns??[])if(turn.status==='pending'&&turn.taskId===task.id){turn.status='interrupted';turn.error='恢复上次中断任务';}return value;},save,
      phase:async(status,patch={})=>{if(status==='reconciling'&&patch.committedRevision!==undefined&&currentOperation){const operation=await repository.getOperation(currentOperation);if(operation?.status==='pending'||operation?.status==='unknown')await repository.finishOperation(lease,currentOperation,'complete',{committedRevision:patch.committedRevision});}task=await repository.transition(lease,status,patch as AgentTaskPatch);if(terminal.has(status)||['paused','blocked','stalled','awaiting-rebase','awaiting-acceptance'].includes(status))finished=true;},
      assertComplete:()=>repository.assertCanComplete(lease),
      restoreAccepted:async(signal)=>{
        const rows=await repository.database.query<{id:string;result_json:string}>("SELECT id,result_json FROM agent_operations WHERE task_id=? AND status='complete' AND result_json IS NOT NULL ORDER BY created_at,id",[task.id]),candidates:AgentCandidatePayload[]=[];let revision:number|undefined;
        for(const row of rows){const prior=JSON.parse(row.result_json) as {receipt?:{candidateId?:string};acceptedCandidate?:AgentCandidatePayload};if(!prior.acceptedCandidate)continue;
          if(!this.options.externalTool||!prior.receipt?.candidateId)throw error('ACCEPTANCE_RECOVERY_REQUIRED','成员候选缺少可重新验证的验收引用');
          signal.throwIfAborted();await repository.reserveBudget(lease,{toolCalls:1});const result=await this.options.externalTool('agent_accept',{candidateId:prior.receipt.candidateId},{lease,projectId,snapshot:structuredClone(snapshot),taskId:task.id,sessionId:session.id,request,toolOperationId:row.id},signal) as {acceptedCandidate?:AgentCandidatePayload;snapshot?:StudioSnapshot};
          if(!result.acceptedCandidate||result.acceptedCandidate.project.id!==projectId)throw error('ACCEPTANCE_RECOVERY_REQUIRED','重新验证没有返回当前工程候选');if(revision!==undefined&&revision!==result.acceptedCandidate.baseRevision)throw error('REVISION_CONFLICT','恢复成员候选期间工程再次变化，请刷新后继续');revision=result.acceptedCandidate.baseRevision;candidates.push(result.acceptedCandidate);if(result.snapshot)snapshot=structuredClone(result.snapshot);
        }return {candidates,...(candidates.length?{snapshot:structuredClone(snapshot)}:{})};
      },
      reserve:async amount=>{if(amount.modelCalls){const resolved=await this.options.providers.registry.resolve(request.role??{provider:request.provider,model:request.model});if(contentHash(resolved)!==contentHash(modelSnapshot))throw error('MODEL_SNAPSHOT_CHANGED','执行期间模型配置已改变');}await repository.reserveBudget(lease,amount);},
      reconcile:async()=>{const current=await repository.getTask(task.id);if(current.committedRevision!==undefined)return {projectId,committedRevision:current.committedRevision};if(!projectId){const [outbox]=await repository.database.query<{operation_id:string;target_project_id:string}>('SELECT * FROM conversation_create_outbox WHERE task_id=?',[task.id]);if(outbox){let receipt:{committedRevision:number}|undefined;try{receipt=await this.options.backend.call('operation.get',{projectId:outbox.target_project_id,operationId:outbox.operation_id});}catch{}if(receipt){const moved=await this.transferCreation(repository,outbox.target_project_id,session.id,task.id,receipt.committedRevision);repository=moved.repository;session=moved.session;task=moved.task;projectId=outbox.target_project_id;lease={...lease,projectId};execution.lease=lease;return {projectId,committedRevision:receipt.committedRevision};}}}return {projectId};},
      mutation:async(operationId,payload)=>{currentOperation=operationId;const operation=await repository.beginOperation(lease,operationId,payload);if(payload.endpoint==='create'&&!projectId){const targetId=(payload.project as {id:string}).id;await repository.database.transaction([{sql:"INSERT INTO conversation_create_outbox(operation_id,session_id,task_id,target_project_id,payload_hash,payload_json,state,updated_at) VALUES(?,?,?,?,?,?,'pending',?) ON CONFLICT(operation_id) DO NOTHING",params:[operationId,session.id,task.id,targetId,operation.payloadHash,stableJson(payload),new Date().toISOString()]}]);return {operation:{id:operation.id,payloadHash:operation.payloadHash}};}return {operation:{id:operation.id,payloadHash:operation.payloadHash,taskId:lease.taskId,sessionId:lease.sessionId,generation:lease.generation,leaseOwner:lease.leaseOwner}};},
      validate:async params=>{await repository.assertLease(lease);return this.options.backend.call<ValidationReceipt>('candidate.validate',params);},
      externalTool:async(tool,args,signal)=>{
        await repository.assertLease(lease);if(!this.options.externalTool)throw error('AGENT_RUNTIME_UNAVAILABLE','内置协作运行时不可用');
        const durable=['agent_delegate','agent_accept'].includes(tool),toolOperationId='tool-'+contentHash({taskId:task.id,tool,args,...(!durable?{generation:lease.generation,sequence:toolSequence++}:{})}).slice(0,48);
        const operation=await repository.beginOperation(lease,toolOperationId,{tool,args});if(operation.status==='complete'&&tool!=='agent_accept')return structuredClone(operation.result);
        try{const result=await this.options.externalTool(tool,args,{lease,projectId,snapshot:structuredClone(snapshot),taskId:task.id,sessionId:session.id,request,toolOperationId},signal);if(operation.status!=='complete')await repository.finishOperation(lease,toolOperationId,'complete',result);const refreshed=(result as {snapshot?:StudioSnapshot})?.snapshot;if(refreshed&&projectId&&refreshed.project?.id===projectId)snapshot=structuredClone(refreshed);return result;}
        catch(failure){await repository.finishOperation(lease,toolOperationId,'unknown',undefined,failure instanceof Error?failure.message:String(failure)).catch(()=>{});throw failure;}
      },
      projectCreated:async(id,conversation)=>{
        if(projectId===id)return;const revision=conversation.turns?.at(-1)?.committedRevision;if(revision===undefined)throw error('COMMIT_RECEIPT_REQUIRED','新工程缺少提交回执');
        const moved=await this.transferCreation(repository,id,session.id,task.id,revision,conversation);repository=moved.repository;session=moved.session;task=moved.task;projectId=id;lease={...lease,projectId:id};execution.lease=lease;snapshot=await this.options.backend.call('current',{projectId:id});
      },
    };
    const service=new ConversationService(this.options.backend,this.options.providers,this.options.dataDirectory,{sessionId:session.id,execution});
    const heartbeat=setInterval(()=>{if(finished||heartbeatRunning)return;heartbeatRunning=true;void repository.renewLease(lease).then(value=>{lease=value;execution.lease=value;}).catch(()=>service.cancel()).finally(()=>{heartbeatRunning=false;});},AGENT_LIMITS.heartbeatMs);heartbeat.unref();
    const promise=service.send(input);this.active.set(input.sessionId,{service,taskId:task.id,generation:lease.generation,projectId,promise});
    try{return await promise;}catch(failure){
      if(!finished){const current=await repository.getTask(task.id).catch(()=>undefined);if(current&&!terminal.has(current.status)){
        const stored=await repository.getSession<Conversation>(session.id);if(conversationData(stored.data)&&!stored.data.turns?.some(turn=>turn.taskId===task.id)){
          const value=structuredClone(stored.data),now=new Date().toISOString(),turnId='recovery-'+task.id;value.turns??=[];value.turns.push({id:turnId,taskId:task.id,operationId:input.operationId,requestHash,request:structuredClone(request),status:'failed',phase:'failed',createdAt:now,updatedAt:now,error:failure instanceof Error?failure.message:String(failure)});value.messages.push({id:randomUUID(),role:'user',content:request.message,turnId,status:'failed',createdAt:now});session=await repository.saveSessionData(session.id,value,stored.version);
        }
        await repository.transition(lease,'failed',{error:failure instanceof Error?failure.message:String(failure),checkpoint:'failed'}).catch(()=>{});
      }}throw failure;
    }finally{finished=true;clearInterval(heartbeat);this.active.delete(input.sessionId);}
  }
  async shutdown(){this.stopped=true;await Promise.allSettled([...this.active.values()].map(value=>value.service.shutdown()));}
}
