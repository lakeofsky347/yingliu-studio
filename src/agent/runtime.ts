import { randomUUID } from 'node:crypto';
import { AGENT_LIMITS, type AgentCandidate, type AgentCandidatePayload, type AgentControl, type AgentDecision, type AgentExecuteResult, type AgentLease, type AgentRuntimePorts, type AgentTask, type DelegateAgentInput } from './contracts.ts';
import { AgentRepository, agentError, assertCandidateScope, assertScopeSubset, contentHash, stableJson } from './repository.ts';

const SYSTEM = `你是映流 Studio 内置的受管制作成员。只负责任务包中的目标与镜头范围，不继承父会话聊天。你没有文件系统、Shell、工程主版本写入或再次委派权限。每次只输出一个严格 JSON 对象，type 为 read / execute / submit / blocked。
read: {"type":"read","query":{"shotIds":["授权镜头ID"],"fields":["source"]}}；只读取本任务的冻结版本。
execute: {"type":"execute","tool":"code|image|video|speech","shotId":"授权镜头ID","input":{...}}；制作代码时 input 可给 source:{html,css,js}，通过宿主受控工具生成候选。不能提交任意URL、路径、认证信息或源码以外的可执行命令。
submit: {"type":"submit","summary":"不超过4000字符的完成摘要"}；提交已生成候选等待验证。只读检查任务可提交证据。模型提交不等于验收完成。
blocked: {"type":"blocked","reason":"需要主管处理的明确原因"}。缺少依赖或权限时报告阻塞，不能扩大任务。不得宣称运行了没有回执的检查。`;
const stopped = new Set(['awaiting-acceptance','awaiting-rebase','paused','blocked','stalled','succeeded','failed','cancelled']);
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw agentError('INVALID_DECISION','成员响应必须是 JSON 对象');return value as Record<string,unknown>;}
function decision(text:string):AgentDecision {
  if(text.length>2_000_000)throw agentError('RESULT_LIMIT','成员输出超过限制');
  const raw=object(JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')));
  if(raw.type==='read'){const query=object(raw.query??{});for(const field of ['shotIds','fields'])if(query[field]!==undefined&&(!Array.isArray(query[field])||(query[field] as unknown[]).some(id=>typeof id!=='string')))throw agentError('INVALID_DECISION','读取范围必须是文本数组');return {type:'read',query:query as Extract<AgentDecision,{type:'read'}>['query']};}
  if(raw.type==='execute'){if(!['code','image','video','speech'].includes(String(raw.tool)))throw agentError('TOOL_DENIED','成员请求未获准的执行工具');return {type:'execute',tool:raw.tool as Extract<AgentDecision,{type:'execute'}>['tool'],shotId:raw.shotId===undefined?undefined:String(raw.shotId),input:object(raw.input??{})};}
  if(raw.type==='submit'){if(typeof raw.summary!=='string'||!raw.summary.trim()||stableJson({summary:raw.summary,evidence:raw.evidence}).length>AGENT_LIMITS.resultChars)throw agentError('RESULT_LIMIT','成员摘要不能为空或超过限制');return {type:'submit',summary:raw.summary,...(raw.candidate?{candidate:raw.candidate as AgentCandidatePayload}:{}),...(raw.evidence!==undefined?{evidence:raw.evidence}:{})};}
  if(raw.type==='blocked'&&typeof raw.reason==='string')return {type:'blocked',reason:raw.reason.slice(0,AGENT_LIMITS.resultChars)};
  throw agentError('INVALID_DECISION','成员响应 type 无效');
}
function cancellation(signal:AbortSignal):unknown{return signal.reason??agentError('ABORTED','任务已暂停');}
async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();return new Promise<T>((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(cancellation(signal));};signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);signal.aborted?reject(cancellation(signal)):resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});}

/** Actual isolated model loops. Shared state and execution admission are owned by SQLite. */
export class AgentRuntime {
  private readonly owner='runtime-'+randomUUID();
  private readonly running=new Map<string,{controller:AbortController;promise:Promise<AgentTask>}>();
  private closed=false;
  constructor(readonly repository:AgentRepository,private readonly ports:AgentRuntimePorts){}

  async delegate(input:DelegateAgentInput,signal?:AbortSignal):Promise<AgentTask>{
    if(this.closed)throw agentError('RUNTIME_CLOSED','智能体运行时已关闭');signal?.throwIfAborted();
    const parent=await this.repository.assertLease(input.parentLease);if(parent.id!==input.parentTaskId||parent.parentTaskId)throw agentError('DEPTH_LIMIT','只有根任务可以委派成员');
    if(!parent.scope.capabilities.includes('*')&&!parent.scope.capabilities.includes('spawn'))throw agentError('SCOPE_DENIED','本任务没有委派权限');
    assertScopeSubset(input.scope,parent.scope);if(input.scope.capabilities.some(cap=>['spawn','commit','merge'].includes(cap))||input.scope.capabilities.includes('*'))throw agentError('SCOPE_DENIED','成员不能取得再委派或主版本提交权限');
    const operationId=input.operationId??randomUUID(),identity=contentHash({parent:parent.id,operationId}).slice(0,40),taskId='agent-task-'+identity;
    const delegationHash=contentHash({mode:input.mode,sessionId:input.sessionId,goal:input.goal,role:input.role,scope:input.scope,dependencies:input.dependencies??[],acceptance:input.acceptance??[],modelSnapshot:input.modelSnapshot,data:input.data});
    try{const prior=await this.repository.getTask(taskId);if(prior.data?.delegationHash!==delegationHash)throw agentError('OPERATION_MISMATCH','委派操作 ID 已用于不同任务');return prior;}catch(error){if((error as {code?:string}).code!=='TASK_NOT_FOUND')throw error;}
    const pending=(await this.repository.listCandidates()).filter(item=>['submitted','validated'].includes(item.status));if(pending.length>=AGENT_LIMITS.pendingAcceptance)throw agentError('ACCEPTANCE_BACKPRESSURE','待验收产物已满，请先验收现有结果');
    let session;if(input.sessionId){session=await this.repository.getSession(input.sessionId);if(session.kind!=='team'||input.mode!=='team'||session.parentSessionId!==parent.sessionId)throw agentError('SESSION_SCOPE_DENIED','不能给其他根会话或一次性成员重新派发');}
    else session=await this.repository.createSession({id:'agent-session-'+identity,kind:input.mode,parentSessionId:parent.sessionId,name:input.name??input.goal.slice(0,40),data:{}});
    const task=await this.repository.createTask({id:taskId,operationId:'delegate-'+identity,sessionId:session.id,parentTaskId:parent.id,goal:input.goal,role:input.role,scope:input.scope,dependencies:input.dependencies,acceptance:input.acceptance,modelSnapshot:input.modelSnapshot,data:{...input.data,delegationHash}});
    void this.run(task.id).catch(()=>{});return task;
  }
  async run(taskId:string,signal?:AbortSignal):Promise<AgentTask>{
    if(this.closed)throw agentError('RUNTIME_CLOSED','智能体运行时已关闭');
    const active=this.running.get(taskId);
    if(active){let settled=false;active.promise.then(()=>{settled=true;},()=>{settled=true;});await Promise.resolve();if(!settled&&this.running.get(taskId)===active)return active.promise;}
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const promise=this.execute(taskId,controller).finally(async()=>{signal?.removeEventListener('abort',abort);if(this.running.get(taskId)?.promise===promise)this.running.delete(taskId);const task=await this.repository.getTask(taskId);if(!this.closed&&task.status==='awaiting-acceptance')void this.schedule().catch(()=>{});});
    this.running.set(taskId,{controller,promise});return promise;
  }
  private async schedule():Promise<void>{if((await this.repository.listCandidates()).filter(candidate=>['submitted','validated'].includes(candidate.status)).length>=AGENT_LIMITS.pendingAcceptance)return;for(const task of await this.repository.listTasks())if(task.parentTaskId&&task.status==='queued'&&!this.running.has(task.id)&&this.running.size<AGENT_LIMITS.activeChildren)void this.run(task.id).catch(()=>{});}
  private async execute(taskId:string,controller:AbortController,retries=0):Promise<AgentTask>{
    let lease:AgentLease|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,renewing=false;
    const signal=controller.signal;
    try{
      signal.throwIfAborted();lease=await this.repository.claimTask(taskId,this.owner);let task=await this.repository.getTask(taskId);
      heartbeat=setInterval(()=>{if(renewing||!lease)return;renewing=true;void this.repository.renewLease(lease).then(next=>{lease=next;},error=>controller.abort(error)).finally(()=>{renewing=false;});},AGENT_LIMITS.heartbeatMs);heartbeat.unref?.();
      if(this.ports.preflight)await abortable(this.ports.preflight(task,signal),signal);
      const rawContext=await abortable(this.ports.context(task,signal),signal);
      if(!task.data?.baseline){const context=object(rawContext);if(!context.project)throw agentError('BASELINE_REQUIRED','任务上下文必须包含冻结工程');task=await this.repository.transition(lease,'planning',{data:{baseline:{project:context.project,sources:context.sources??{}}}});}
      const memberSession=await this.repository.getSession<Record<string,unknown>>(task.sessionId),acceptedMemory=memberSession.kind==='team'?memberSession.data.acceptedMemory:undefined;
      if(acceptedMemory&&stableJson(acceptedMemory).length>AGENT_LIMITS.resultChars)throw agentError('CONTEXT_LIMIT','团队验收摘要超过4000字符');
      const context=stableJson({goal:task.goal,scope:task.scope,acceptance:task.acceptance??[],context:rawContext,acceptedMemory});
      if(context.length>AGENT_LIMITS.contextChars)throw agentError('CONTEXT_LIMIT','任务上下文超过24000字符，请缩小镜头范围或按需读取');
      let checkpoint=object(task.data?.runtime??{}),round=Number(checkpoint.round??0),observation=typeof checkpoint.observation==='string'?checkpoint.observation:'请先读取必要信息，再执行或提交。',previous=typeof checkpoint.fingerprint==='string'?checkpoint.fingerprint:'',repeated=Number(checkpoint.repeated??0),repairs=Number(checkpoint.repairs??0),latest=checkpoint.candidate as AgentCandidatePayload|undefined;const readEvidence=Array.isArray(checkpoint.readEvidence)?checkpoint.readEvidence as string[]:[];
      for(;round<AGENT_LIMITS.rounds;round++){
        signal.throwIfAborted();task=await this.repository.transition(lease,'planning');
        const modelOperation=`${task.id}:model:${round}`,prior=await this.repository.getOperation(modelOperation);let output:string;
        if(prior){if(prior.status!=='complete')throw agentError('RECONCILIATION_REQUIRED','上次模型调用结果未知，不能自动重复请求');output=String(prior.result);}
        else{
          if(SYSTEM.length+context.length+observation.length>AGENT_LIMITS.contextChars)throw agentError('CONTEXT_LIMIT','完整模型上下文超过24000字符，请缩小任务范围');
          await this.repository.reserveBudget(lease,{modelCalls:1});await this.repository.beginOperation(lease,modelOperation,{role:task.role,round,modelSnapshot:task.modelSnapshot,contextHash:contentHash(context),observation});
          try{output=await abortable(this.ports.text({task,role:task.role,system:SYSTEM,messages:[{role:'user',content:context},{role:'user',content:observation.slice(0,AGENT_LIMITS.resultChars)}],signal}),signal);await this.repository.finishOperation(lease,modelOperation,'complete',output);}
          catch(error){await this.repository.finishOperation(lease,modelOperation,'unknown',undefined,error instanceof Error?error.message:String(error)).catch(()=>{});throw error;}
        }
        const action=decision(output);if(!prior)await this.repository.recordMessage(lease,'decision',action.type==='execute'?'执行 '+action.tool+'：'+action.shotId:action.type==='submit'?action.summary:action.type==='blocked'?action.reason:'按任务范围读取',{round,type:action.type,...(action.type==='execute'?{tool:action.tool,shotId:action.shotId}:{})});const fingerprint=contentHash({action,observation});repeated=fingerprint===previous?repeated+1:0;previous=fingerprint;
        if(repeated>=1){return await this.repository.transition(lease,'stalled',{error:'相同输入与动作没有产生新进展',checkpoint:'no-progress'});}
        if(action.type==='blocked')return await this.repository.transition(lease,'blocked',{error:action.reason});
        if(action.type==='read'){
          this.checkRead(task,action.query);const readOperation=`${task.id}:read:${round}`,existing=await this.repository.getOperation(readOperation);let value:unknown;
          if(existing?.status==='complete')value=existing.result;
          else{await this.repository.reserveBudget(lease,{toolCalls:1});await this.repository.beginOperation(lease,readOperation,{query:action.query,baseRevision:(task.data?.baseline as {project?:{revision:number}})?.project?.revision});try{value=await abortable(this.ports.inspect(task,action.query,signal),signal);if(stableJson(value).length>AGENT_LIMITS.resultChars)throw agentError('CONTEXT_LIMIT','读取结果超过4000字符，请缩小读取范围');await this.repository.finishOperation(lease,readOperation,'complete',value);}catch(error){await this.repository.finishOperation(lease,readOperation,'unknown',undefined,error instanceof Error?error.message:String(error)).catch(()=>{});throw error;}}
          const text=stableJson(value);if(text.length>AGENT_LIMITS.resultChars)throw agentError('CONTEXT_LIMIT','读取结果超过4000字符，请缩小读取范围');observation=text;readEvidence.push(contentHash({query:action.query,value}));
        }else if(action.type==='execute'){
          this.checkExecute(task,action);task=await this.repository.transition(lease,'executing');const operationId=`${task.id}:execute:${contentHash(action).slice(0,32)}`,existing=await this.repository.getOperation(operationId);let result:AgentExecuteResult;
          if(existing){if(existing.status!=='complete')throw agentError('RECONCILIATION_REQUIRED','上次制作请求结果未知，必须先对账');result=existing.result as AgentExecuteResult;}
          else{await this.repository.reserveBudget(lease,{toolCalls:1});await this.repository.beginOperation(lease,operationId,action);try{result=await abortable(this.ports.execute(task,action,operationId,lease,signal),signal);await this.repository.finishOperation(lease,operationId,'complete',result);}catch(error){await this.repository.finishOperation(lease,operationId,'unknown',undefined,error instanceof Error?error.message:String(error)).catch(()=>{});throw error;}}
          if(result.candidate){latest=this.completeCandidate(task,result.candidate);assertCandidateScope(task,latest);}observation=stableJson({summary:result.summary,artifactRefs:result.artifactRefs,evidence:result.evidence,remoteTaskId:result.remoteTaskId,candidateHash:latest?contentHash(latest):undefined}).slice(0,AGENT_LIMITS.resultChars);
        }else{
          const base=task.data?.baseline as {project:AgentCandidatePayload['project'];sources:AgentCandidatePayload['sources']};
          const payload=this.completeCandidate(task,action.candidate??latest??{project:base.project,sources:base.sources,baseRevision:base.project.revision});assertCandidateScope(task,payload);
          if(task.scope.writeFields.length&&!latest&&!action.candidate)throw agentError('OUTPUT_REQUIRED','制作任务尚无候选产物，不能仅凭完成声明结束');
          if(!task.scope.writeFields.length&&(!readEvidence.length||action.evidence===undefined))throw agentError('EVIDENCE_REQUIRED','只读任务须提供实际读取回执与结构化检查结论');
          task=await this.repository.transition(lease,'validating',{data:{runtime:{...checkpoint,round,readEvidence,evidence:action.evidence,candidate:payload}}});const candidate=await this.repository.submitCandidate(lease,payload,action.summary);await this.repository.reserveBudget(lease,{toolCalls:1});const receipt=await abortable(this.ports.validate(task,candidate,signal),signal);await this.repository.recordValidation(lease,candidate.id,receipt);
          if(receipt.status!=='passed'){
            latest=payload;repairs++;observation=stableJson({candidateId:candidate.id,validationId:receipt.id,status:'failed',checks:receipt.checks,message:'按检查结果修复现有候选；已完成的素材生成不能重复提交。'}).slice(0,AGENT_LIMITS.resultChars);
            if(repairs>2)return await this.repository.transition(lease,'blocked',{candidateId:candidate.id,error:'候选已达到每步骤两次修复上限',checkpoint:'repair-limit',data:{runtime:{...checkpoint,round:round+1,repairs,observation,candidate:latest,readEvidence}}});
          }else return await this.repository.transition(lease,'awaiting-acceptance',{candidateId:candidate.id,summary:action.summary,checkpoint:'validated'});
        }
        checkpoint={round:round+1,observation,fingerprint:previous,repeated,repairs,candidate:latest,readEvidence};task=await this.repository.transition(lease,'executing',{data:{runtime:checkpoint}});
      }
      return await this.repository.transition(lease,'blocked',{error:'成员已达到四轮规划上限，保留已有产物',checkpoint:'round-limit'});
    }catch(error){
      const code=(error as {code?:string})?.code;
      if(code==='DB_CONFLICT'&&retries<2){if(heartbeat)clearInterval(heartbeat);heartbeat=undefined;return this.execute(taskId,controller,retries+1);}
      const message=error instanceof Error?error.message:String(error),checkpoint=code??'execution-error';
      const task=await this.repository.getTask(taskId);if(!lease||task.generation!==lease.generation||task.status==='cancelled')return {...task,checkpoint:task.checkpoint??checkpoint,error:task.error??message};
      const status=signal.aborted?'paused':code==='RECONCILIATION_REQUIRED'?'blocked':code==='SCOPE_DENIED'||code==='TOOL_DENIED'?'failed':'blocked';
      try{return await this.repository.transition(lease,status,{error:message,checkpoint});}
      catch(persistError){const current=await this.repository.getTask(taskId);return {...current,checkpoint,error:message+'；状态写入失败：'+(persistError instanceof Error?persistError.message:String(persistError))};}
    }finally{if(heartbeat)clearInterval(heartbeat);}
  }
  private completeCandidate(task:AgentTask,payload:AgentCandidatePayload):AgentCandidatePayload{
    const baseline=task.data?.baseline as {project:AgentCandidatePayload['project'];sources:AgentCandidatePayload['sources']};if(!baseline?.project||!payload?.project||!payload.sources)throw agentError('INVALID_CANDIDATE','候选缺少固定工程与源码');return {...payload,sources:{...baseline.sources,...payload.sources},baseRevision:payload.baseRevision};
  }
  private checkRead(task:AgentTask,query:Extract<AgentDecision,{type:'read'}>['query']):void{if(query.shotIds?.some(id=>!task.scope.shotIds.includes('*')&&!task.scope.shotIds.includes(id)))throw agentError('SCOPE_DENIED','读取超出任务镜头范围');if(query.taskId&&query.taskId!==task.id)throw agentError('SCOPE_DENIED','成员不能读取其他任务上下文');for(const field of ['offset','limit'] as const)if(query[field]!==undefined&&(!Number.isSafeInteger(query[field])||query[field]!<0||field==='limit'&&query[field]!>AGENT_LIMITS.resultChars))throw agentError('INVALID_READ','读取分页参数无效');}
  private checkExecute(task:AgentTask,action:Extract<AgentDecision,{type:'execute'}>):void{
    if(!task.scope.capabilities.includes(action.tool))throw agentError('TOOL_DENIED','任务没有 '+action.tool+' 工具权限');if(!action.shotId||!task.scope.shotIds.includes(action.shotId))throw agentError('SCOPE_DENIED','执行必须指定授权镜头');
    const forbidden=new Set(['url','baseUrl','path','headers','apiKey','credential','command','shell','sessionId','projectId','taskId','generation']);if(Object.keys(action.input).some(key=>forbidden.has(key)))throw agentError('TOOL_DENIED','成员不能设置工具身份、地址、路径或认证参数');
  }
  async wait(taskId:string,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<AgentTask>{const deadline=Date.now()+Math.min(180_000,Math.max(0,options.timeoutMs??10_000));for(;;){options.signal?.throwIfAborted();const task=await this.repository.getTask(taskId);if(stopped.has(task.status)||Date.now()>=deadline)return task;if(task.status==='queued'&&!this.running.has(taskId))void this.run(taskId).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,100));}}
  async result(taskId:string):Promise<{task:AgentTask;candidate?:AgentCandidate;validation?:Awaited<ReturnType<AgentRepository['getValidation']>>}>{const task=await this.repository.getTask(taskId),candidate=task.candidateId?await this.repository.getCandidate(task.candidateId):undefined;return {task,candidate,validation:candidate?.validationId?await this.repository.getValidation(candidate.validationId):undefined};}
  async accept(parentLease:AgentLease,candidateId:string):Promise<AgentCandidate>{const candidate=await this.repository.acceptCandidate(parentLease,candidateId);if(!this.closed)void this.schedule().catch(()=>{});return candidate;}
  async pause(taskId:string,control?:AgentControl):Promise<AgentTask>{if(control)await this.repository.controlTask(taskId,'pause',control);const active=this.running.get(taskId);if(active){active.controller.abort(agentError('PAUSED','制作成员已暂停'));return active.promise;}return this.repository.getTask(taskId);}
  async resume(taskId:string,control:AgentControl):Promise<AgentTask>{const task=await this.repository.controlTask(taskId,'resume',control);if(task.parentTaskId)void this.run(taskId).catch(()=>{});return task;}
  async cancelChild(parentLease:AgentLease,childId:string,expectedGeneration:number):Promise<AgentTask>{const task=await this.repository.cancelChild(parentLease,childId,expectedGeneration);this.running.get(childId)?.controller.abort(agentError('CANCELLED','根任务已撤销成员授权'));return task;}
  async cancel(taskId:string,control?:AgentControl):Promise<AgentTask>{const task=control?await this.repository.controlTask(taskId,'cancel',control):await this.repository.cancelTask(taskId);for(const [id,active]of this.running){const value=await this.repository.getTask(id);if(value.status==='cancelled')active.controller.abort(agentError('CANCELLED','任务授权已撤销'));}return task;}
  async dispose():Promise<void>{this.closed=true;for(const active of this.running.values())active.controller.abort(agentError('RUNTIME_CLOSED','运行时正在关闭'));await Promise.allSettled([...this.running.values()].map(item=>item.promise));}
}
