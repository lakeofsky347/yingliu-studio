import { resolve } from 'node:path';
import { AppBackend } from './backend.ts';
import { ProviderManager } from './model.ts';
import { ConversationService } from './conversation.ts';
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

export const ENDPOINTS=new Set(['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','list','focus','audio','tts','history','undo','redo','rename','duplicate','archive','tasks','retry','packs.list','app.health','app.exportProject','app.importProject','providers.get','providers.save','providers.check','chat.history','chat.send','chat.cancel']);
for(const endpoint of ['models.list','models.connection.save','models.connection.remove','models.model.save','models.model.remove','models.role.bind','models.check','media.generate','media.list','media.get','media.retry','media.pause','media.cancel','media.apply','video.clip.save','video.clip.remove','video.clip.extract'])ENDPOINTS.add(endpoint);
for(const endpoint of ['workflows.run','workflows.list','workflows.get','workflows.retry','workflows.pause','workflows.apply'])ENDPOINTS.add(endpoint);
for(const endpoint of ['styles.list','styles.save','styles.delete'])ENDPOINTS.add(endpoint);
export class MemorySecrets implements SecretStore {
  private values=new Map<string,string>();
  async get(ref:string){return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
export async function createApplication(options:{dataDirectory:string;credentials:SecretStore;reveal?:(path:string)=>Promise<void>}){
  const dataDirectory=resolve(options.dataDirectory);
  const providers=new ProviderManager(dataDirectory,options.credentials);await providers.initialize();
  const backend=new AppBackend({...options,dataDirectory,providers:providers.host()});
  const conversation=new ConversationService(backend,providers,dataDirectory);
  await backend.call('catalog');
  const media=new MediaTaskService(dataDirectory,providers.registry,backend.mediaPort());
  await media.recover();
  const workflowPort:WorkflowPort={
    snapshot:id=>backend.call('current',{projectId:id}),source:(id,shotId)=>backend.call('source',{projectId:id,shotId}),
    commit:(id,expectedRevision,project,sources,label)=>backend.call('apply',{projectId:id,expectedRevision,project,sources:Object.entries(sources).map(([shotId,source])=>({shotId,source})),label}),
    stageMedia:(id,task,files,signal)=>backend.stageWorkflowMedia(id,task,files,signal),
    capture:(id,frame,signal,candidate)=>backend.workflowCapture(id,frame,signal,candidate),
    text:async(role,prompt,signal,_request,images)=>providers.complete([{role:'user',content:images?.length?[{type:'text',text:prompt},...images.map(image=>({type:'image_url' as const,image_url:{url:`data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`}}))]:prompt}],'你是视频制作团队的'+role+'。只依据提供的工程和实际图像执行任务。',signal,undefined,role),
    voice:async(id,shotId,text,signal)=>{
      const state=providers.registry.snapshot();if(!state.roles.some(binding=>binding.role==='speech'))return backend.workflowVoice(id,shotId,text,signal);
      let release:(()=>void)|undefined;
      try{
        const {selected,key}=await (async()=>{const selected=await providers.registry.resolve('speech');release=providers.registry.acquire(selected.connection.id,selected.model.id);const key=await providers.registry.credential(selected.connection);return {selected,key};})().catch(error=>{throw Object.assign(error instanceof Error?error:new Error(String(error)),{submissionUncertain:false});});
        return await backend.workflowVoice(id,shotId,text,signal,{endpoint:selected.connection.baseUrl,model:selected.model.model,voice:String(selected.model.parameters.voice??'alloy'),speed:Number(selected.model.parameters.speed??1),enabled:true,requestTimeoutMs:selected.connection.requestTimeoutMs,...(key?{apiKey:key}:{})});
      }finally{release?.();}
    },
  };
  const workflows=new WorkflowService(dataDirectory,media,workflowPort);
  const requests=new Set<Promise<RpcResult>>();let stopping=false,disposal:Promise<void>|undefined;
  async function dispatch(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    try{
      if(!ENDPOINTS.has(endpoint))throw new Error('不支持此应用操作');
      const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
      let value:unknown;
      switch(endpoint){
        case 'archive':{
          if(data.archived!==false){const snapshot=await backend.call('current',{projectId:data.projectId});const id=snapshot.project?.id;if(id&&((await workflows.list(id)).some(item=>item.status==='running')||(await media.list(id)).some(item=>item.observation==='active'&&!['ready','complete','failed','cancelled'].includes(item.phase))))throw new Error('工程仍有媒体或协作任务，请先停止本地等待再归档');}
          return backend.route(endpoint,payload);
        }
        case 'workflows.run':value=await workflows.run(data as unknown as WorkflowRequest);break;
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
        case 'media.generate':value=await media.generate(data as unknown as MediaRequest);break;
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
        case 'chat.history':value=await conversation.history(typeof data.projectId==='string'?data.projectId:undefined);break;
        case 'chat.send':value=await conversation.send(data as unknown as ChatInput);break;
        case 'chat.cancel':value=await conversation.cancel();break;
        default:return backend.route(endpoint,payload);
      }
      return {ok:true,value};
    }catch(error){return {ok:false,error:{code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'APP_ERROR',message:error instanceof Error?error.message:'操作失败'}};}
  }
  function route(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    if(stopping)return Promise.resolve({ok:false,error:{code:'APP_SHUTTING_DOWN',message:'应用正在关闭，请重新打开后继续'}});
    const request=dispatch(endpoint,payload);requests.add(request);void request.finally(()=>requests.delete(request));return request;
  }
  return {backend,providers,conversation,media,workflows,route,dispose(){return disposal??=(async()=>{stopping=true;await conversation.shutdown();await workflows.dispose();await media.dispose();await Promise.allSettled([...requests]);await backend.dispose();})();}};
}
export type Application=Awaited<ReturnType<typeof createApplication>>;
