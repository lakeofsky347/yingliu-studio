import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {randomUUID} from 'node:crypto';
import type { ProviderGroup, RpcResult, StudioSnapshot, VideoProject, TtsSettings, VideoStyle } from '../shared/types.ts';
import {normalizeVideoStyle} from '../shared/video-style.ts';
import {atomicRename} from './atomic-rename.ts';
import type { HostContext } from './platform.ts';
import { StudioService } from './service.ts';
import {AgentDatabase} from '../agent/database.ts';
import type { MediaProjectPort } from '../jobs/contracts.ts';
import type { GeneratedFile, MediaTask } from '../jobs/contracts.ts';

export interface StudioFocus { shotId?:string; frame?:number }
export interface ProjectLocation { id:string; path:string; title:string; archived?:boolean; archivedAt?:string; createdAt?:string; updatedAt?:string }
interface HubIndex { version:1; selected?:string; projects:ProjectLocation[]; sessions:Record<string,string> }
type Input=Record<string,unknown>;
type HubSnapshot=StudioSnapshot & {sessionId?:string;focus?:StudioFocus;projects:ProjectLocation[]};

function record(value:unknown):Input {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Input:{};}
function resultValue<T>(result:RpcResult):T {if(!result.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value as T;}

/** One service per project; changing the visible page does not redirect a background render. */
export class ProjectHub {
  readonly baseDirectory:string;
  private services=new Map<string,StudioService>();
  private pendingServices=new Map<string,Promise<StudioService>>();
  private openings:Promise<unknown>=Promise.resolve();
  private disposed=false;
  private bootstrap:StudioService;
  private index:HubIndex={version:1,projects:[],sessions:{}};
  private readonly indexDatabase:AgentDatabase;
  private indexVersion=-1;
  private initialized:Promise<void>;
  private writes:Promise<void>=Promise.resolve();
  private selectedSession?:string;
  private focus?:StudioFocus;
  private providers:ProviderGroup[]=[];
  private tts?:TtsSettings;
  private styles:VideoStyle[]=[];
  private styleWrites:Promise<void>=Promise.resolve();
  constructor(private ctx:HostContext,config:{baseDirectory?:string}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.YINGLIU_PROJECTS??join(homedir(),'Documents','YingliuProjects'));
    this.indexDatabase=new AgentDatabase(join(this.baseDirectory,'.studio/registry.sqlite'));
    this.bootstrap=this.makeService();
    this.initialized=this.initialize();
  }
  private makeService(restoreRecent=false){return new StudioService(this.ctx,{baseDirectory:this.baseDirectory,restoreRecent});}
  mediaPort():MediaProjectPort {
    return {
      databasePath:async id=>{await this.initialized;return (await this.service(id)).databasePath();},
      inspect:async id=>{await this.initialized;return (await this.service(id)).inspectMediaProject();},
      readImage:async(id,assetId,shotId)=>{await this.initialized;return (await this.service(id)).readMediaImage(assetId,shotId);},
      validateArtifact:async(path,mime,id,signal)=>{await this.initialized;return (await this.service(id)).validateMediaArtifact(path,mime,signal);},
      applyResult:async input=>{await this.initialized;const service=await this.service(input.projectId);const result=await service.applyMediaResult(input);await this.remember(await service.snapshot());return result;},
    };
  }
  async stageWorkflowMedia(projectId:string,task:MediaTask,files:GeneratedFile[],signal:AbortSignal){await this.initialized;return (await this.service(projectId)).stageWorkflowMedia(task,files,signal);}
  async workflowVoice(projectId:string,shotId:string,text:string,signal:AbortSignal,settings?:TtsSettings){await this.initialized;return (await this.service(projectId)).workflowVoice(shotId,text,signal,settings);}
  async workflowCapture(projectId:string,frame:number,signal:AbortSignal,candidate?:import('../workflows/contracts.ts').WorkflowCandidate){await this.initialized;return (await this.service(projectId)).workflowCapture(frame,signal,candidate);}
  async validateCandidate(projectId:string|undefined,candidate:import('./candidate.ts').CandidateInput,signal?:AbortSignal){await this.initialized;return (projectId?await this.service(projectId):this.bootstrap).validateCandidate(candidate,signal);}
  private async initialize(){
    await this.indexDatabase.transaction([{sql:'CREATE TABLE IF NOT EXISTS hub_index (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, index_json TEXT NOT NULL)'}]);
    if(!(await this.indexDatabase.query('SELECT singleton FROM hub_index WHERE singleton=1')).length){
      try{
        const saved=JSON.parse(await readFile(join(this.baseDirectory,'registry.json'),'utf8'));
        if(saved.version===1&&Array.isArray(saved.projects)&&saved.sessions&&typeof saved.sessions==='object')this.index=saved;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await this.indexDatabase.transaction([{sql:'INSERT OR IGNORE INTO hub_index(singleton,version,index_json) VALUES(1,0,?)',params:[JSON.stringify(this.index)]}]);
    }
    await this.refreshIndex();
    try{
      const saved=JSON.parse(await readFile(join(this.baseDirectory,'styles.json'),'utf8'));
      if(Array.isArray(saved))for(const item of saved){try{this.styles.push(normalizeVideoStyle(item));}catch{/* Ignore malformed style entries without disabling the project library. */}}
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const current=await this.bootstrap.snapshot();
    this.providers=current.providers;this.tts=current.tts;
    if(current.recent.some(recent=>!this.index.projects.some(item=>item.id===recent.id)))await this.updateIndex(index=>{for(const recent of current.recent)if(!index.projects.some(item=>item.id===recent.id))index.projects.push({id:recent.id,path:recent.path,title:recent.title});});
    const previousSelected=this.index.selected;
    const selected=this.index.projects.find(item=>item.id===this.index.selected&&!item.archived)??this.index.projects.find(item=>!item.archived);
    this.index.selected=selected?.id;
    if(selected){
      this.index.selected=undefined;
      for(const candidate of [selected,...this.index.projects.filter(item=>!item.archived&&item.id!==selected.id)]){
        try{const service=await this.service(candidate.id),opened=await service.snapshot();this.index.selected=candidate.id;if(opened.project)for(const id of this.projectSessions(opened.project))if(!this.index.sessions[id])this.index.sessions[id]=opened.project.id;break;}catch{/* A moved/damaged project must not disable the project picker. */}
      }
    }
    const availableSelected=this.index.selected,sessions={...this.index.sessions};
    await this.updateIndex(index=>{if(index.selected===previousSelected)index.selected=availableSelected;for(const [session,id] of Object.entries(sessions))if(!index.sessions[session])index.sessions[session]=id;});
  }
  private projectSessions(project:VideoProject):string[]{
    const values=project.sessionIds??project.extensions.sessionIds;
    return Array.isArray(values)?values.filter((item):item is string=>typeof item==='string'):[];
  }
  private async refreshIndex(){
    const rows=await this.indexDatabase.query<{version:number;index_json:string}>('SELECT version,index_json FROM hub_index WHERE singleton=1');
    if(!rows[0])throw new Error('工程登记数据库缺少 HEAD');
    if(rows[0].version>=this.indexVersion){this.index=JSON.parse(rows[0].index_json);this.indexVersion=rows[0].version;}
  }
  /** Merge from the authoritative index and publish with a short cross-process CAS. */
  private updateIndex(change:(index:HubIndex)=>void){
    const work=this.writes.then(async()=>{
      for(let attempt=0;attempt<20;attempt++){
        const [row]=await this.indexDatabase.query<{version:number;index_json:string}>('SELECT version,index_json FROM hub_index WHERE singleton=1');
        if(!row)throw new Error('工程登记数据库缺少 HEAD');
        const candidate=JSON.parse(row.index_json) as HubIndex;change(candidate);
        try{await this.indexDatabase.transaction([{sql:'UPDATE hub_index SET version=version+1,index_json=? WHERE singleton=1 AND version=?',params:[JSON.stringify(candidate),row.version],expectChanges:1}]);}
        catch(error){if((error as {code?:string}).code==='DB_CONFLICT')continue;throw error;}
        this.index=candidate;this.indexVersion=row.version+1;
        // Legacy readers see a best-effort projection. A write failure never falls back to JSON.
        const file=join(this.baseDirectory,'registry.json'),temporary=file+'.tmp-'+randomUUID();
        try{await writeFile(temporary,JSON.stringify(candidate,null,2)+'\n');await atomicRename(temporary,file);}catch{/* SQLite is authoritative. */}
        finally{await rm(temporary,{force:true}).catch(()=>{});}return;
      }
      throw Object.assign(new Error('工程登记更新冲突，请重试'),{code:'REGISTRY_CONFLICT'});
    });this.writes=work.catch(()=>{});return work;
  }
  private async saveStyles(change:(styles:VideoStyle[])=>void):Promise<void>{
    const work=this.styleWrites.then(async()=>{
      const candidate=structuredClone(this.styles);change(candidate);
      await mkdir(this.baseDirectory,{recursive:true});
      const file=join(this.baseDirectory,'styles.json'),temporary=file+'.tmp-'+randomUUID();
      try{await writeFile(temporary,JSON.stringify(candidate,null,2)+'\n');await atomicRename(temporary,file);this.styles=candidate;}
      finally{await rm(temporary,{force:true}).catch(()=>{});}
    });this.styleWrites=work.catch(()=>{});return work;
  }
  private async saveStyle(data:Input):Promise<RpcResult>{
    const input=record(data.style),id=typeof input.id==='string'&&input.id.trim()?input.id.trim():randomUUID();
    let saved:VideoStyle;
    await this.saveStyles(styles=>{
      const index=styles.findIndex(style=>style.id===id),previous=styles[index],now=new Date().toISOString();
      saved=normalizeVideoStyle({...input,id,createdAt:previous?.createdAt??input.createdAt??now,updatedAt:now});
      if(index<0)styles.push(saved);else styles[index]=saved;
    });
    return {ok:true,value:{style:saved!,styles:structuredClone(this.styles)}};
  }
  private async remember(snapshot:StudioSnapshot,select=false){
    if(!snapshot.project||!snapshot.root)return;
    const saved=this.index.projects.find(item=>item.id===snapshot.project!.id);
    const entry:ProjectLocation={...saved,id:snapshot.project.id,path:snapshot.root,title:snapshot.project.title,createdAt:snapshot.project.createdAt,updatedAt:snapshot.project.updatedAt};
    const previous=this.index.projects.findIndex(item=>item.id===entry.id);
    if(previous>=0&&JSON.stringify(this.index.projects[previous])===JSON.stringify(entry)&&(!select||this.index.selected===entry.id))return;
    await this.updateIndex(index=>{const previous=index.projects.findIndex(item=>item.id===entry.id);const candidate={...index.projects[previous],id:entry.id,path:entry.path,title:entry.title,createdAt:entry.createdAt,updatedAt:entry.updatedAt};if(previous<0)index.projects.push(candidate);else index.projects[previous]=candidate;if(select)index.selected=entry.id;});
  }
  private async discoverProject(id:string):Promise<void>{
    if(this.index.projects.some(project=>project.id===id))return;
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('工程 ID 无效');
    let names:string[]=[];try{names=await readdir(this.baseDirectory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    for(const name of names.filter(name=>name.endsWith('-'+id))){
      const root=join(this.baseDirectory,name);let project:VideoProject;
      try{project=await this.bootstrap.store.readProject(root);}catch{continue;}
      if(project.id===id){await this.remember({project,root} as StudioSnapshot);return;}
    }
  }
  private async service(projectId?:string):Promise<StudioService>{
    const id=projectId??this.index.selected;
    if(!id)return this.bootstrap;
    await this.discoverProject(id);
    const entry=this.index.projects.find(item=>item.id===id);if(entry?.archived)throw new Error('此工程已归档，请先恢复');
    const loaded=this.services.get(id);if(loaded)return loaded;
    const existing=this.pendingServices.get(id);if(existing)return existing;
    const location=this.index.projects.find(item=>item.id===id);if(!location)throw new Error('未找到视频工程，请先创建或打开');
    const pending=(async()=>{
      const service=this.makeService();
      try{const snapshot=resultValue<StudioSnapshot>(await service.rpc('open',{path:location.path}));if(snapshot.project?.id!==id)throw new Error('工程 ID 与保存位置不一致');this.services.set(id,service);return service;}
      catch(error){await service.dispose();throw error;}
    })();
    this.pendingServices.set(id,pending);
    try{return await pending;}finally{this.pendingServices.delete(id);}
  }
  private async bind(service:StudioService,sessionId:string){
    if(!sessionId.trim())throw new Error('请选择关联会话');
    const snapshot=await service.snapshot(),project=snapshot.project;if(!project)throw new Error('请先创建或打开视频工程');
    const sessions=[...new Set([...this.projectSessions(project),sessionId])];
    if(!this.projectSessions(project).includes(sessionId))resultValue(await service.rpc('save',{expectedRevision:project.revision,project:{...project,sessionIds:sessions,extensions:{...project.extensions,sessionIds:sessions}}}));
    await this.updateIndex(index=>{index.sessions[sessionId]=project.id;});
  }
  private async decorate(service:StudioService,sessionId?:string):Promise<HubSnapshot>{
    const snapshot=await service.snapshot();
    const selected=snapshot.project?.id===this.index.selected;
    return {...snapshot,providers:this.providers,tts:this.tts??snapshot.tts,sessionId:sessionId??(selected?this.selectedSession:undefined)??(snapshot.project?this.projectSessions(snapshot.project)[0]:undefined),focus:selected?this.focus:undefined,projects:structuredClone(this.index.projects.filter(item=>!item.archived)),recent:snapshot.recent.filter(item=>!this.index.projects.find(entry=>entry.id===item.id)?.archived),styles:structuredClone(this.styles)};
  }
  /** Resolve by explicit project or session; never silently reuse another session's project. */
  async resolveProject(input:Input,sessionId?:string):Promise<{service:StudioService;projectId:string;snapshot:StudioSnapshot}>{
    await this.initialized;
    const id=typeof input.projectId==='string'?input.projectId:sessionId?this.index.sessions[sessionId]:this.index.selected;
    if(!id)throw new Error('当前会话还没有视频工程，请先使用 video_project 创建或绑定工程');
    const service=await this.service(id),snapshot=await service.snapshot();
    if(!snapshot.project)throw new Error('视频工程尚未打开');
    return {service,projectId:snapshot.project.id,snapshot};
  }
  async call<T=HubSnapshot>(endpoint:string,input:unknown={}):Promise<T>{return resultValue<T>(await this.route(endpoint,input));}
  async route(endpoint:string,payload:unknown):Promise<RpcResult>{
    if(['create','open','duplicate','archive','restore','bind','bindSession','focus'].includes(endpoint)){
      const result=this.openings.then(()=>this.performRoute(endpoint,payload));this.openings=result.then(()=>undefined,()=>undefined);return result;
    }
    return this.performRoute(endpoint,payload);
  }
  private async performRoute(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('应用服务已停止');await this.refreshIndex();const data=record(payload),sessionId=typeof data.sessionId==='string'?data.sessionId:undefined;
      const projectInput=record(data.project);
      if(endpoint==='candidate.validate'&&!data.projectId)return this.bootstrap.rpc(endpoint,data);
      let id=typeof data.projectId==='string'?data.projectId:typeof projectInput.id==='string'?projectInput.id:sessionId?this.index.sessions[sessionId]:this.index.selected;
      if(endpoint==='styles.list')return {ok:true,value:{styles:structuredClone(this.styles)}};
      if(endpoint==='styles.save')return await this.saveStyle(data);
      if(endpoint==='styles.delete'){
        if(typeof data.id!=='string'||!data.id)throw new Error('缺少风格 ID');
        await this.saveStyles(styles=>{const index=styles.findIndex(style=>style.id===data.id);if(index>=0)styles.splice(index,1);});
        return {ok:true,value:{styles:structuredClone(this.styles)}};
      }
      if(endpoint==='list')return {ok:true,value:{projects:structuredClone(this.index.projects.filter(item=>data.includeArchived===true||!item.archived)),sessions:{...this.index.sessions},selected:this.index.selected}};
      if(endpoint==='archive'||endpoint==='restore'){
        const location=this.index.projects.find(item=>item.id===id);if(!location)throw new Error('未找到视频工程');
        const archived=endpoint==='archive'&&data.archived!==false;
        if(archived&&!location.archived&&(await (await this.service(id)).snapshot()).task?.status==='running')throw new Error('工程仍有任务运行，请先停止任务再归档');
        await this.updateIndex(index=>{
          const entry=index.projects.find(item=>item.id===id)!;entry.archived=archived;entry.archivedAt=archived?new Date().toISOString():undefined;
          if(archived&&index.selected===id)index.selected=index.projects.find(item=>!item.archived)?.id;
          else if(!archived&&data.select!==false)index.selected=entry.id;
        });
        this.selectedSession=undefined;this.focus=undefined;return {ok:true,value:await this.decorate(await this.service())};
      }
      if(endpoint==='duplicate'){
        const original=await this.service(id),copied=resultValue<{root:string;project:VideoProject}>(await original.rpc('duplicate',data)),service=this.makeService();
        try{const snapshot=resultValue<StudioSnapshot>(await service.rpc('open',{path:copied.root}));await this.remember(snapshot,data.select!==false);this.services.set(snapshot.project!.id,service);if(data.select!==false){this.selectedSession=undefined;this.focus=undefined;}return {ok:true,value:await this.decorate(service)};}catch(error){await service.dispose();throw error;}
      }
      if(endpoint==='create'||endpoint==='open'){
        if(endpoint==='create'&&typeof projectInput.id==='string'){await this.discoverProject(projectInput.id);if(this.index.projects.some(item=>item.id===projectInput.id)){const service=await this.service(projectInput.id);if(!data.operation&&!data.operationId)throw new Error('工程 ID 已存在，请复制工程或生成新 ID');const receipt=resultValue(await service.rpc('operation.get',{operationId:record(data.operation).id??data.operationId}));if(!receipt)throw Object.assign(new Error('工程 ID 已存在但操作回执不匹配'),{code:'OPERATION_CONFLICT'});return service.rpc('create',data);}}
        if(endpoint==='open'&&typeof data.path==='string'){
          const requestedPath=resolve(data.path),existing=this.index.projects.find(item=>resolve(item.path)===requestedPath);
          if(existing){
            if(existing.archived)await this.updateIndex(index=>{const entry=index.projects.find(item=>item.id===existing.id)!;entry.archived=false;delete entry.archivedAt;});
            const service=await this.service(existing.id);if(sessionId)await this.bind(service,sessionId);
            if(data.select!==false){await this.updateIndex(index=>{index.selected=existing.id;});this.selectedSession=sessionId;this.focus=undefined;}
            return {ok:true,value:await this.decorate(service,sessionId)};
          }
        }
        const service=this.makeService();
        try{
          const snapshot=resultValue<StudioSnapshot>(await service.rpc(endpoint,data));
          if(!snapshot.project)throw new Error('创建或打开工程失败');
          const previous=this.services.get(snapshot.project.id);if(previous){if(endpoint==='create'&&(data.operation||data.operationId)){await service.dispose();return previous.rpc('create',data);}throw new Error('该工程已打开，请使用 projectId 选择工程');}
          if(sessionId)await this.bind(service,sessionId);await this.remember(await service.snapshot(),data.select!==false);
          this.services.set(snapshot.project.id,service);if(data.select!==false){this.selectedSession=sessionId;this.focus=undefined;}
          return {ok:true,value:await this.decorate(service,sessionId)};
        }catch(error){await service.dispose();throw error;}
      }
      if(endpoint==='current'&&sessionId&&!id){
        const empty=await this.bootstrap.snapshot();return {ok:true,value:{...empty,project:null,root:null,previewUrl:null,previewRevision:null,assetBaseUrl:null,task:null,sessionId,focus:undefined,projects:this.index.projects.filter(item=>!item.archived)}};
      }
      if((endpoint==='operation.get'||endpoint==='operation.receipt'||endpoint==='operation.intent')&&typeof id==='string'){await this.discoverProject(id);if(!this.index.projects.some(project=>project.id===id))return {ok:true,value:undefined};}
      const service=await this.service(id);
      if(endpoint==='bind'||endpoint==='bindSession'){
        if(!sessionId)throw new Error('请选择关联会话');await this.bind(service,sessionId);if(data.select!==false){const snapshot=await service.snapshot();await this.updateIndex(index=>{index.selected=snapshot.project!.id;});this.selectedSession=sessionId;}
        return {ok:true,value:await this.decorate(service,sessionId)};
      }
      if(endpoint==='focus'){
        const snapshot=await service.snapshot();if(!snapshot.project)throw new Error('请先创建视频工程');
        await this.updateIndex(index=>{index.selected=snapshot.project!.id;});this.selectedSession=sessionId??this.projectSessions(snapshot.project)[0];
        this.focus={...(typeof data.shotId==='string'?{shotId:data.shotId}:{}),...(typeof data.frame==='number'?{frame:Math.max(0,Math.floor(data.frame))}:{})};
        return {ok:true,value:await this.decorate(service,sessionId)};
      }
      const result=await service.rpc(endpoint,data);if(!result.ok)return result;
      if(['source','inspect','history','tasks','jobs','candidate.validate','operation.get','operation.receipt','operation.intent'].includes(endpoint)||record(result.value).operationReceipt){await this.remember(await service.snapshot());return result;}
      if(endpoint==='catalog')this.providers=(result.value as StudioSnapshot).providers;
      if(endpoint==='tts'){const snapshot=result.value as StudioSnapshot;this.tts=snapshot.tts;}
      await this.remember(await service.snapshot());return {ok:true,value:await this.decorate(service,sessionId)};
    }catch(error){return {ok:false,error:{code:error instanceof Error&&'code' in error?String(error.code):'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){this.disposed=true;await this.initialized;await this.openings;await Promise.allSettled(this.pendingServices.values());await Promise.all([...new Set([this.bootstrap,...this.services.values()])].map(service=>service.dispose()));await this.writes;await this.styleWrites;await this.indexDatabase.close();}
}
