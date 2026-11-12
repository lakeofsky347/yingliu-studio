import { resolve } from 'node:path';
import { AppBackend } from './backend.ts';
import { ProviderManager } from './model.ts';
import { ConversationSessions } from './conversation-sessions.ts';
import { AgentCoordinator } from './agent-coordinator.ts';
import { agentError } from '../agent/repository.ts';
import type { RpcResult } from '../shared/types.ts';
import type { ChatInput, SecretStore } from './contracts.ts';
import { foundationPacks } from './packs.ts';
import { applicationHealth } from './health.ts';
import { exportProjectArchive, importProjectArchive } from './archive.ts';
import { MediaTaskService } from '../jobs/media-tasks.ts';
import type { MediaRequest } from '../jobs/contracts.ts';
import type { ConnectionInput, ModelInput, ModelRole } from '../models/contracts.ts';
import { WorkflowService } from '../workflows/service.ts';
import type { WorkflowRequest, WorkflowPort } from '../workflows/contracts.ts';
import { AgentService } from '../agent/service.ts';
import type { AgentPort, AgentStartInput } from '../agent/tool-contracts.ts';
import { redactKey } from '../agent/model-client.ts';
import type { GenRole } from '../agent/tool-contracts.ts';
import { ROLE_OUTPUT, ROLE_PROTOCOLS } from '../models/contracts.ts';
import { pollTemplate, submitTemplate } from '../models/adapters/template.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ENDPOINTS=new Set(['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','list','focus','audio','tts','history','undo','redo','rename','duplicate','archive','tasks','retry','packs.list','app.health','app.exportProject','app.importProject','providers.get','providers.save','providers.check','chat.history','chat.send','chat.cancel']);
for(const endpoint of ['models.list','models.connection.save','models.connection.remove','models.model.save','models.model.remove','models.role.bind','models.check','media.generate','media.list','media.get','media.retry','media.pause','media.cancel','media.apply','video.clip.save','video.clip.remove','video.clip.extract'])ENDPOINTS.add(endpoint);
for(const endpoint of ['workflows.run','workflows.list','workflows.get','workflows.retry','workflows.pause','workflows.apply'])ENDPOINTS.add(endpoint);
for(const endpoint of ['styles.list','styles.save','styles.delete'])ENDPOINTS.add(endpoint);
for(const endpoint of ['sessions.create','sessions.list','sessions.get','chat.status','agent.tasks','agent.task.get','agent.task.pause','agent.task.resume','agent.task.retry','agent.task.cancel','agent.candidate.get','candidate.validate','operation.get','operation.receipt','operation.intent'])ENDPOINTS.add(endpoint);
for(const endpoint of ['agent.start','agent.list','agent.get','agent.trace','agent.approve','agent.reject','agent.resume','agent.pause','agent.cancel','agent.tools','agent.capabilities','story.get','story.save','agent.qc','agent.qc.last','agent.ledger','agent.budget.set'])ENDPOINTS.add(endpoint);
const projectWrites=new Set(['create','save','import','saveSource','restoreSource','generate','apply','audio','undo','redo','rename','duplicate','archive','retry','video.clip.save','video.clip.remove','video.clip.extract','app.importProject','media.apply','workflows.apply']);
const protocolWrites=new Set([...projectWrites,'chat.send','media.generate','workflows.run']);
function protocol(endpoint:string,data:Record<string,unknown>){
  if(data.execution!==undefined||data.operation!==undefined&&typeof data.operation!=='string'||data.leaseOwner!==undefined)throw agentError('RUNTIME_IDENTITY_FORBIDDEN','执行身份只能由应用创建，调用方不能提供内部 operation、execution 或 leaseOwner');
  if(!protocolWrites.has(endpoint))return data;
  if(typeof data.operationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(data.operationId))throw agentError('PROTOCOL_UPGRADE_REQUIRED','写操作必须包含稳定的 operationId；请升级调用方并在重试时复用原 ID');
  const creation=endpoint==='create'||endpoint==='app.importProject'||endpoint==='chat.send'&&!data.projectId;
  if(creation?data.expectedRevision!==null:!Number.isSafeInteger(data.expectedRevision)||Number(data.expectedRevision)<0)throw agentError('PROTOCOL_UPGRADE_REQUIRED',creation?'新建操作必须显式提供 expectedRevision:null':'修改工程必须提供读取所得的 expectedRevision；请先读取工程，禁止使用隐式最新版本');
  if(['chat.send','workflows.run'].includes(endpoint)&&(typeof data.sessionId!=='string'||!data.sessionId.trim()))throw agentError('PROTOCOL_UPGRADE_REQUIRED','智能体请求必须提供由 sessions.create 创建的 sessionId');
  return data;
}
export class MemorySecrets implements SecretStore {
  private values=new Map<string,string>();
  async get(ref:string){return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
export async function createApplication(options:{dataDirectory:string;credentials:SecretStore;reveal?:(path:string)=>Promise<void>;fetch?:typeof fetch}){
  const dataDirectory=resolve(options.dataDirectory);
  const providers=new ProviderManager(dataDirectory,options.credentials,options.fetch?{fetch:options.fetch}:{});await providers.initialize();
  const backend=new AppBackend({...options,dataDirectory,providers:providers.host()});
  await backend.call('catalog');
  const media=new MediaTaskService(dataDirectory,providers.registry,backend.mediaPort());
  await media.recover();
  const workflowPort:WorkflowPort={
    configuration:async request=>{
      const roles:ModelRole[]=['director',request.visual==='code'?'scene':request.visual];if(request.review)roles.push('vision');if(request.narration)roles.push('speech');
      return Promise.all([...new Set(roles)].map(async role=>{
        if(role==='speech'&&!providers.registry.snapshot().roles.some(binding=>binding.role==='speech')){const snapshot=await backend.call('current',{projectId:request.projectId});const {apiKey:_key,...settings}=snapshot.tts??{};return {role,local:settings};}
        const state=providers.registry.snapshot(),definition=role==='director'&&request.textRoute?state.models.find(model=>model.connectionId===request.textRoute!.provider&&model.model===request.textRoute!.model):state.models.find(model=>model.id===state.roles.find(binding=>binding.role===role)?.modelId),selected=state.connections.find(connection=>connection.id===definition?.connectionId);
        if(!definition||!selected)return {role,missing:true};const {credentialRef:_reference,...connection}=selected;return {role,connection,model:definition};
      }));
    },
    snapshot:id=>backend.call('current',{projectId:id}),source:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    commit:(id,expectedRevision,project,sources,label,operation)=>backend.call('apply',{projectId:id,expectedRevision,project,sources:Object.entries(sources).map(([shotId,source])=>({shotId,source})),label,operation,validationId:operation?.validationId}),
    validate:(id,candidate,signal)=>backend.validateCandidate(id,candidate,signal),
    operationReceipt:(projectId,operationId)=>backend.operationReceipt(projectId,operationId),
    stageMedia:(id,task,files,signal)=>backend.stageWorkflowMedia(id,task,files,signal),
    capture:(id,frame,signal,candidate)=>backend.workflowCapture(id,frame,signal,candidate),
    text:async(role,prompt,signal,request,images)=>providers.complete([{role:'user',content:images?.length?[{type:'text',text:prompt},...images.map(image=>({type:'image_url' as const,image_url:{url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}}))]:prompt}],'你是视频制作团队的'+role+'。只依据提供的工程和实际图像执行任务。',signal,undefined,role==='director'&&request.textRoute?request.textRoute:role,request.sessionId),
    voice:async(id,shotId,text,signal,selection)=>{
      const state=providers.registry.snapshot();if(!selection&&!state.roles.some(binding=>binding.role==='speech'))return backend.workflowVoice(id,shotId,text,signal);
      let release:(()=>void)|undefined;
      try{
        const {selected,key}=await (async()=>{const selected=await providers.registry.resolve(selection??'speech');release=providers.registry.acquire(selected.connection.id,selected.model.id);const key=await providers.registry.credential(selected.connection);return {selected,key};})().catch(error=>{throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});});
        return await backend.workflowVoice(id,shotId,text,signal,{endpoint:selected.connection.baseUrl,model:selected.model.model,voice:String(selected.model.parameters.voice??'alloy'),speed:Number(selected.model.parameters.speed??1),enabled:true,requestTimeoutMs:selected.connection.requestTimeoutMs,...(key?{apiKey:key}:{})});
      }finally{release?.();}
    },
  };
  const agents=new AgentCoordinator({dataDirectory,backend,providers,media,voice:workflowPort.voice});
  const conversation=new ConversationSessions({backend,providers,dataDirectory,repositoryFor:agents.repositoryFor,externalTool:agents.externalTool});
  const workflows=new WorkflowService(dataDirectory,media,workflowPort);
  async function knownKeys():Promise<string[]>{const keys:string[]=[];for(const connection of providers.registry.snapshot().connections){try{const key=await providers.registry.credential(connection);if(key)keys.push(key);}catch{}}return keys;}
  async function importGenerated(id:string,name:string,description:string,mime:string,bytes:Uint8Array){
    const current=await backend.call('current',{projectId:id});
    const snapshot=await backend.call('import',{projectId:id,expectedRevision:current.project?.revision,name,description,mime,dataBase64:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`});
    const asset=snapshot.project?.assets.at(-1);if(!asset)throw new Error('素材导入失败');return asset;
  }
  const agentPort:AgentPort={
    snapshot:id=>backend.call('current',{projectId:id}),
    readSource:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    saveSource:(id,shotId,expectedRevision,source)=>backend.call('saveSource',{projectId:id,shotId,expectedRevision,source}),
    commit:(id,expectedRevision,project,sources,label)=>workflowPort.commit(id,expectedRevision,project,sources,label),
    route:(endpoint,payload)=>route(endpoint,payload) as ReturnType<AgentPort['route']>,
    capture:async(id,frame,signal)=>{const shot=await backend.workflowCapture(id,frame,signal) as unknown as {bytes?:Uint8Array;buffer?:Uint8Array;mime?:string;frame?:number;shotId:string};return {bytes:shot.bytes??shot.buffer??new Uint8Array(),mime:shot.mime??'image/png',frame:shot.frame??frame,shotId:shot.shotId??''};},
    voice:async(id,shotId,text,signal)=>{const asset=await workflowPort.voice(id,shotId,text,signal);return {id:asset.id,name:asset.name};},
    capabilities:async()=>{
      const state=providers.registry.snapshot(),roles:GenRole[]=[],models:Partial<Record<GenRole,string>>={};
      for(const binding of state.roles){const model=state.models.find(m=>m.id===binding.modelId),connection=state.connections.find(c=>c.id===model?.connectionId);
        if(!model?.enabled||!connection?.enabled||!ROLE_PROTOCOLS[binding.role].includes(connection.protocol)||!model.outputModalities.includes(ROLE_OUTPUT[binding.role]))continue;
        if(['image','video','speech','music','sfx','vision'].includes(binding.role)){roles.push(binding.role as GenRole);models[binding.role as GenRole]=model.name;}}
      if(!roles.includes('speech')){try{const snapshot=await backend.call('current');if(snapshot.ttsConfigured&&snapshot.tts?.enabled){roles.push('speech');models.speech='应用内配音设置';}}catch{}}
      let director:string|undefined;try{director=(await providers.registry.resolve('director')).model.name;}catch{}
      return {roles,models,...(director?{director}:{})};
    },
    importImage:async(id,name,bytes,mime)=>{if(!/^image\/(png|jpeg|webp)$/.test(mime))throw new Error('不支持的图片格式');const asset=await importGenerated(id,name,'智能体截取的尾帧',mime,bytes);return {id:asset.id,name:asset.name};},
    importAudio:async(id,name,bytes,mime)=>{const asset=await importGenerated(id,name,'智能体本地合成',mime,bytes);return {id:asset.id,name:asset.name};},
    generateAudio:async(id,role,prompt,{durationSeconds,signal})=>{
      const resolved=await providers.registry.resolve(role);
      if(role==='speech'&&resolved.connection.protocol==='speech'){const shot=(await backend.call('current',{projectId:id})).project?.shotOrder[0];if(!shot)throw new Error('工程没有镜头');const asset=await workflowPort.voice(id,shot,prompt,signal);return {id:asset.id,name:asset.name,cost:null};}
      if(resolved.connection.protocol!=='async-task')throw new Error('该角色的模型协议不支持音频生成');
      const release=providers.registry.acquire(resolved.connection.id,resolved.model.id);
      try{
        const context={connection:resolved.connection,key:await providers.registry.credential(resolved.connection),signal,fetch:options.fetch};
        let result=await submitTemplate(context,{clientRequestId:randomUUID(),model:resolved.model,prompt,duration:durationSeconds,parameters:{}},'audio');
        let bytes:Uint8Array,mime:string;let cost:number|null=null;
        if('kind' in result){bytes=result.bytes;mime=result.mimeType;}
        else{
          const deadline=Date.now()+Math.max(60000,resolved.connection.requestTimeoutMs*6);
          while(result.status==='queued'||result.status==='running'){if(Date.now()>deadline)throw new Error('音频生成等待超时；云端任务可能仍在执行');await new Promise(r=>setTimeout(r,Number(resolved.model.parameters.pollIntervalMs)||2000));signal.throwIfAborted();result=await pollTemplate(context,resolved.model,result.jobId,'audio');}
          if(result.status!=='succeeded'||!result.artifacts?.length)throw new Error('音频生成失败：'+(result.error??result.status));
          cost=typeof result.usage?.cost==='number'?result.usage.cost:null;const artifact=result.artifacts[0];
          if(artifact.base64){bytes=Buffer.from(artifact.base64,'base64');mime=artifact.mimeType;}
          else{const url=new URL(artifact.url!);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('音频产物地址须为 HTTPS');
            const response=await (options.fetch??fetch)(url.href,{signal});if(!response.ok)throw new Error('下载音频失败（HTTP '+response.status+'）');const buffer=new Uint8Array(await response.arrayBuffer());if(!buffer.length||buffer.length>64*1024*1024)throw new Error('音频为空或超过 64 MiB');bytes=buffer;mime=(response.headers.get('content-type')?.split(';')[0]||artifact.mimeType);}
        }
        if(!mime.startsWith('audio/'))mime='audio/mpeg';
        const asset=await importGenerated(id,(role==='music'?'音乐 · ':role==='sfx'?'音效 · ':'配音 · ')+prompt.slice(0,24),'由 '+resolved.model.name+' 生成',mime,bytes);return {id:asset.id,name:asset.name,cost};
      }finally{release();}
    },
    vision:async(prompt,images,signal)=>{await providers.registry.resolve('vision');return workflowPort.text('vision',prompt,signal,{} as WorkflowRequest,images);},
  };
  const agent=new AgentService(join(dataDirectory,'agent-runs'),agentPort,{
    fetch:options.fetch,dataDirectory:join(dataDirectory,'agent-data'),
    redact:async text=>{let value=text;for(const key of await knownKeys())value=redactKey(value,key);return value;},
    resolveModel:async()=>{
      const resolved=await providers.registry.resolve('director'),parameters=resolved.model.parameters as Record<string,unknown>;
      let vision=false;try{await providers.registry.resolve('vision');vision=true;}catch{}
      return {connectionId:resolved.connection.id,parameters,vision:vision||resolved.model.inputModalities.includes('image'),config:{baseUrl:resolved.connection.baseUrl,model:resolved.model.model,key:await providers.registry.credential(resolved.connection),
        timeoutMs:Number(resolved.connection.requestTimeoutMs)||120000,maxTokens:Number(parameters.maxTokens)||4096,...(typeof parameters.temperature==='number'?{temperature:parameters.temperature}:{}),supportsTools:parameters.supportsTools!==false}};
    },
  });
  await agent.initialize();
  const requests=new Set<Promise<RpcResult>>();let stopping=false,disposal:Promise<void>|undefined;
  async function dispatch(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    try{
      if(!ENDPOINTS.has(endpoint))throw new Error('不支持此应用操作');
      const data=protocol(endpoint,payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{});
      let value:unknown;
      switch(endpoint){
        case 'archive':{
          if(data.archived!==false){const snapshot=await backend.call('current',{projectId:data.projectId});const id=snapshot.project?.id;if(id&&((await workflows.list(id)).some(item=>item.status==='running')||(await media.list(id)).some(item=>item.observation==='active'&&!['ready','complete','failed','cancelled'].includes(item.phase))))throw new Error('工程仍有媒体或协作任务，请先停止本地等待再归档');}
          return backend.route(endpoint,data);
        }
        case 'agent.start':value=await agent.start(data as unknown as AgentStartInput);break;
        case 'agent.list':value={runs:await agent.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'agent.get':value=await agent.get(String(data.runId));break;
        case 'agent.trace':value={events:await agent.trace(String(data.runId))};break;
        case 'agent.approve':value=await agent.approve(String(data.runId),String(data.callId));break;
        case 'agent.reject':value=await agent.reject(String(data.runId),String(data.callId),typeof data.reason==='string'?data.reason:'');break;
        case 'agent.resume':value=await agent.resume(String(data.runId));break;
        case 'agent.pause':value=await agent.pause(String(data.runId));break;
        case 'agent.cancel':value=await agent.cancel(String(data.runId));break;
        case 'agent.tools':value={tools:agent.toolList.map(tool=>({name:tool.name,risk:tool.risk,description:tool.description}))};break;
        case 'agent.capabilities':value=await agent.capabilities();break;
        case 'story.get':value=await agent.story(String(data.projectId));break;
        case 'story.save':value=await agent.saveStory(String(data.projectId),(data.story??{}) as Record<string,unknown>,Number(data.expectedVersion));break;
        case 'agent.qc':value=await agent.runQc(String(data.projectId));break;
        case 'agent.qc.last':value={report:await agent.lastQc(String(data.projectId))};break;
        case 'agent.ledger':value=await agent.ledger(String(data.projectId));break;
        case 'agent.budget.set':value=await agent.setProjectBudget(String(data.projectId),data.maxCost===null||data.maxCost===undefined||data.maxCost===''?null:Number(data.maxCost),typeof data.currency==='string'?data.currency:undefined);break;
        case 'workflows.run':{const repository=await agents.repositoryFor(String(data.projectId)),session=await repository.getSession(String(data.sessionId));if(session.kind!=='root')throw agentError('ROOT_SESSION_REQUIRED','协作制作必须由真实根会话发起');value=await workflows.run(data as unknown as WorkflowRequest);break;}
        case 'workflows.list':value={workflows:await workflows.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'workflows.get':value=await workflows.get(String(data.workflowId));break;
        case 'workflows.retry':value=await workflows.retry(String(data.workflowId));break;
        case 'workflows.pause':value=await workflows.pause(String(data.workflowId));break;
        case 'workflows.apply':value=await workflows.apply(String(data.workflowId),Number(data.expectedRevision));break;
        case 'models.list':value=await providers.registry.list();break;
        case 'models.connection.save':value=await providers.registry.saveConnection(data as ConnectionInput);await backend.call('catalog');break;
        case 'models.connection.remove':await providers.registry.removeConnection(String(data.id));value=await providers.registry.list();break;
        case 'models.model.save':value=await providers.registry.saveModel(data as unknown as ModelInput);await backend.call('catalog');break;
        case 'models.model.remove':await providers.registry.removeModel(String(data.id));value=await providers.registry.list();break;
        case 'models.role.bind':await providers.registry.bindRole(data.role as ModelRole,typeof data.modelId==='string'?data.modelId:null);value=await providers.registry.list();break;
        case 'models.check':value=await providers.check(typeof data.connectionId==='string'?data.connectionId:undefined);break;
        case 'media.generate':value=await media.generate({...data,clientRequestId:typeof data.clientRequestId==='string'?data.clientRequestId:data.operationId} as unknown as MediaRequest);break;
        case 'media.list':value={tasks:await media.list(typeof data.projectId==='string'?data.projectId:undefined)};break;
        case 'media.get':value=await media.get(String(data.taskId));break;
        case 'media.retry':value=await media.retry(String(data.taskId));break;
        case 'media.pause':value=await media.pause(String(data.taskId));break;
        case 'media.cancel':value=await media.cancel(String(data.taskId));break;
        case 'media.apply':value=await media.apply(String(data.taskId),Number(data.expectedRevision));break;
        case 'app.health':{const snapshot=await backend.call('current');value=await applicationHealth(snapshot.environment,await providers.settings(),dataDirectory);break;}
        case 'app.exportProject':value=await exportProjectArchive(backend,data);break;
        case 'app.importProject':value=await importProjectArchive(backend,data);break;
        case 'packs.list':value=foundationPacks;break;
        case 'providers.get':value=await providers.settings();break;
        case 'providers.save':value=await providers.save(data);await backend.call('catalog');break;
        case 'providers.check':value=await providers.check();break;
        case 'sessions.create':value=await conversation.create(data);break;
        case 'sessions.list':value={sessions:await conversation.list(data)};break;
        case 'sessions.get':case 'chat.status':value=await conversation.status(data as unknown as {sessionId:string;projectId?:string});break;
        case 'agent.tasks':value=await agents.tasks(typeof data.projectId==='string'?data.projectId:undefined,typeof data.sessionId==='string'?data.sessionId:undefined);break;
        case 'agent.task.get':{const result=await agents.tasks(typeof data.projectId==='string'?data.projectId:undefined,String(data.sessionId));value=result.tasks.find(task=>task.id===data.taskId);if(!value)throw agentError('TASK_NOT_FOUND','任务不属于此会话');break;}
        case 'agent.task.pause':case 'agent.task.resume':case 'agent.task.retry':case 'agent.task.cancel':{
          if(typeof data.sessionId!=='string'||typeof data.taskId!=='string'||!Number.isSafeInteger(data.generation)||typeof data.operationId!=='string')throw agentError('PROTOCOL_UPGRADE_REQUIRED','任务控制需要 sessionId、taskId、generation 和 operationId');
          const repository=await agents.repositoryFor(typeof data.projectId==='string'?data.projectId:undefined),task=await repository.getTask(data.taskId);
          value=task.parentTaskId?await agents.control(endpoint.split('.').at(-1)!,data):await conversation.control(endpoint.split('.').at(-1)! as 'pause'|'resume'|'retry'|'cancel',data as unknown as {projectId?:string;sessionId:string;taskId:string;generation:number;operationId:string});break;
        }
        case 'agent.candidate.get':{
          const repository=await agents.repositoryFor(typeof data.projectId==='string'?data.projectId:undefined),candidate=await repository.getCandidate(String(data.candidateId)),task=await repository.getTask(candidate.taskId),root=await repository.getTask(task.rootTaskId);
          if(root.sessionId!==data.sessionId)throw agentError('SCOPE_DENIED','产物不属于此根会话');value={id:candidate.id,taskId:candidate.taskId,hash:candidate.hash,status:candidate.status,summary:candidate.summary,validation:candidate.validationId?await repository.getValidation(candidate.validationId):undefined};break;
        }
        case 'chat.history':value=await conversation.history(data as unknown as {sessionId:string;projectId?:string});break;
        case 'chat.send':value=await conversation.send(data as unknown as ChatInput);break;
        case 'chat.cancel':value=await conversation.cancel(data as unknown as {sessionId:string;projectId?:string;taskId:string;generation:number});break;
        default:return backend.route(endpoint,data);
      }
      return {ok:true,value};
    }catch(error){return {ok:false,error:{code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'APP_ERROR',message:error instanceof Error?error.message:'操作失败'}};}
  }
  function route(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    if(stopping)return Promise.resolve({ok:false,error:{code:'APP_SHUTTING_DOWN',message:'应用正在关闭，请重新打开后继续'}});
    const request=dispatch(endpoint,payload);requests.add(request);void request.finally(()=>requests.delete(request));return request;
  }
  return {backend,providers,conversation,agents,agent,media,workflows,route,dispose(){return disposal??=(async()=>{stopping=true;await agent.dispose();await conversation.shutdown();await workflows.dispose();await media.dispose();await Promise.allSettled([...requests]);await agents.dispose();await backend.dispose();})();}};
}
export type Application=Awaited<ReturnType<typeof createApplication>>;
