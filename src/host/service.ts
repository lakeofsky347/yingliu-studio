import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,open,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {homedir} from 'node:os';
import {createProject,compileSpec,defaultSceneSource,updateShot,updateTarget,validateProject,reorderShots} from '../core/index.ts';
import type {VideoProject,StudioSnapshot,TaskState,EnvironmentSettings,ProviderGroup,RpcResult,SceneSource,Shot,ModelRoute,TtsSettings,AudioClip,VideoClip,Asset} from '../shared/types.ts';
import type {HostContext} from './platform.ts';
import {ProjectStore,projectPath,validateStoredProject,validateSources,type CommitOperation} from './store.ts';
import {VideoRenderer,detectEnvironment} from './renderer.ts';
import {AppSceneGenerator,parseSceneSource,normalizeStoryboard} from './generator.ts';
import {SpeechSynthesizer,extractVideoAudio} from './audio.ts';
import type {MediaProjectPort} from '../jobs/contracts.ts';
import {inspectGeneratedMedia,readProjectImage} from '../media/inspect.ts';
import type { GeneratedFile, MediaTask } from '../jobs/contracts.ts';
import {inspectCredential,isCredentialError,updateCredential} from '../app/secrets.ts';
import {defaultTtsSettings,validateTtsSettings} from '../shared/tts-capability.ts';
import {atomicRename} from './atomic-rename.ts';
import {syncDirectory} from './directory-sync.ts';
import {normalizeVideoStyle} from '../shared/video-style.ts';
import {projectOpenPath} from './file-opener.ts';
import {reserveExternalOperation,readExternalOperation} from './operation-intents.ts';
import {validateCandidate as checkCandidate,readValidation,inputHash,type CandidateInput} from './candidate.ts';

interface TaskRequest { endpoint:'preview'|'export'|'generate'; payload:Record<string,string> }
interface RecordedTask extends TaskState { ownerPid?:number; appRecordVersion?:1; revision?:number; request?:TaskRequest; retryOf?:string }

/** Only preflight failures are safe to retry without an ambiguous speech submission. */
export function speechPreflightFailure(error:unknown):Error&{submissionUncertain:false}{
  return Object.assign(new Error(error instanceof Error?error.message:String(error),{cause:error}),{submissionUncertain:false as const});
}

export class StudioService {
  readonly store:ProjectStore;readonly renderer=new VideoRenderer();
  private project:VideoProject|null=null;private root:string|null=null;
  private task:RecordedTask|null=null;private controller?:AbortController;private job?:Promise<void>;
  private commands:Promise<unknown>=Promise.resolve();
  private providers:ProviderGroup[]=[];private previewUrl:string|null=null;private previewRevision:number|null=null;private assetBaseUrl:string|null=null;
  private settings:EnvironmentSettings;private initialized:Promise<void>;private disposed=false;
  private readonly baseDirectory:string;
  private readonly restoreRecent:boolean;
  private readonly speech=new SpeechSynthesizer();
  private audioUrl:string|null=null;
  private tts:TtsSettings;
  constructor(private ctx:HostContext,config:{baseDirectory?:string;restoreRecent?:boolean}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.YINGLIU_PROJECTS??join(homedir(),'Documents','YingliuProjects'));
    this.restoreRecent=config.restoreRecent!==false;
    this.store=new ProjectStore({baseDirectory:this.baseDirectory});
    const env=detectEnvironment();this.settings={browserPath:env.browserPath,ffmpegPath:env.ffmpegPath,ffprobePath:env.ffprobePath};this.tts=defaultTtsSettings(env);
    this.initialized=this.initialize();
  }
  private async initialize(){
    try{this.settings={...this.settings,...JSON.parse(await readFile(join(this.baseDirectory,'environment.json'),'utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const recent=this.restoreRecent?await this.store.recent():[];
    if(recent[0])try{this.project=await this.store.open(recent[0].path);this.root=recent[0].path;await this.recoverTask();await this.refreshPreview();}catch{/* Recent path may have been moved; keep the picker usable. */}
  }
  async snapshot():Promise<StudioSnapshot>{
    await this.initialized;await this.refreshHead();
    const credentials=await inspectCredential(this.ctx.credentials,'YINGLIU_TTS_API_KEY'),recent=await this.store.recent();
    // Capture project and task in one synchronous turn: awaited fields must not mix an old HEAD with a newly completed task.
    return structuredClone({project:this.project,root:this.root,task:this.task,previewUrl:this.previewUrl,previewRevision:this.previewRevision,assetBaseUrl:this.assetBaseUrl,audioUrl:this.audioUrl,tts:{...this.tts,apiKey:undefined},ttsConfigured:credentials.hasKey,credentialStatus:credentials.credentialStatus,providers:this.providers,environment:detectEnvironment(this.settings),recent});
  }
  private async refreshHead():Promise<void>{
    if(!this.root||!this.project)return;
    const project=await this.store.readProject(this.root);
    if(project.revision>this.project.revision){this.project=project;await this.refreshAfterCommit();}
  }
  async databasePath():Promise<string>{await this.initialized;return join(this.required().root,'.studio/state.sqlite');}
  async validateCandidate(candidate:CandidateInput,signal?:AbortSignal){
    await this.initialized;await this.refreshHead();
    if(this.project&&candidate.project.id!==this.project.id)throw new Error('候选工程不匹配');
    return checkCandidate(candidate,this.root??undefined,this.root?join(this.root,'.studio/state.sqlite'):join(this.baseDirectory,'agent-state.sqlite'),this.store,this.renderer,this.settings,signal);
  }
  /** Trusted host port: generated paths never cross the public RPC or model tool surface. */
  async inspectMediaProject(){await this.initialized;await this.refreshHead();const {project}=this.required();return {revision:project.revision,shotIds:project.shots.map(shot=>shot.id)};}
  async readMediaImage(assetId:string,shotId?:string){await this.initialized;await this.refreshHead();const {root,project}=this.required();return readProjectImage(root,project,assetId,shotId);}
  async validateMediaArtifact(path:string,mimeType:string,signal?:AbortSignal){await this.initialized;return inspectGeneratedMedia(path,mimeType,this.settings,signal);}
  async stageWorkflowMedia(task:MediaTask,files:GeneratedFile[],signal:AbortSignal):Promise<Asset[]>{
    await this.initialized;signal.throwIfAborted();if(this.disposed)throw new Error('应用服务已停止');const {root,project}=this.required();if(task.projectId!==project.id)throw new Error('素材任务工程不匹配');
    const environment=structuredClone(this.settings),assets:Asset[]=[];for(const file of files){signal.throwIfAborted();const asset=await this.store.importAsset(root,{path:file.path,mime:file.mimeType,name:file.name,description:task.prompt},environment,signal);asset.generation={taskId:task.id,connectionId:task.connection.id,model:task.model.model,operation:task.operation,prompt:task.prompt,inputHashes:task.inputHashes};assets.push(asset);}return assets;
  }
  async workflowVoice(shotId:string,text:string,signal:AbortSignal,settings?:TtsSettings):Promise<Asset>{
    const prepared=await (async()=>{
      await this.initialized;signal.throwIfAborted();if(this.disposed)throw new Error('应用服务已停止');const {root,project}=this.required(),shot=project.shots.find(item=>item.id===shotId);if(!shot)throw new Error('配音目标镜头不存在');
      if(typeof text!=='string'||!text.trim())throw new Error('配音文本不能为空');
      const speechSettings=structuredClone(settings??await this.speechSettings()),environment=structuredClone(this.settings);if(!speechSettings.enabled)throw new Error('请先配置并启用配音服务');validateTtsSettings(speechSettings,detectEnvironment(environment));signal.throwIfAborted();
      return {root,shot,speechSettings,environment};
    })().catch(error=>{throw speechPreflightFailure(error);});
    return this.speech.synthesize(prepared.root,{text,name:prepared.shot.title+' · 协作配音'},prepared.speechSettings,prepared.environment,signal);
  }
  async workflowCapture(frame:number,signal:AbortSignal,candidate?:import('../workflows/contracts.ts').WorkflowCandidate){
    await this.initialized;signal.throwIfAborted();const {root,project}=this.required();if(candidate){if(candidate.project.id!==project.id)throw new Error('候选工程不匹配');return this.renderer.captureCandidate(root,candidate.project,candidate.sources,this.settings,frame,signal);}
    return this.enqueue(async()=>{signal.throwIfAborted();const {root,project}=this.required(),capture=await this.renderer.capture(root,project,this.settings,frame,signal);return {bytes:await readFile(capture.path),mime:'image/png',sha256:capture.sha256};});
  }
  async applyMediaResult(input:Parameters<MediaProjectPort['applyResult']>[0]):Promise<{assetIds:string[];revision:number}>{
    await this.initialized;
    return this.enqueue(async()=>{
      if(this.disposed)throw new Error('应用服务已停止');await this.refreshHead();this.assertIdle();const {root,project}=this.required();
      const operation=input.operation??{id:'media:'+input.provenance.taskId,payloadHash:inputHash(input)};const receipt=await this.store.operationReceipt(root,operation.id);if(receipt){if(receipt.payloadHash!==operation.payloadHash)throw Object.assign(new Error('媒体操作 ID 参数不一致'),{code:'OPERATION_CONFLICT'});const saved=await this.store.readProject(root,receipt.committedRevision);return structuredClone((saved.extensions.mediaApplications as Record<string,{assetIds:string[];revision:number}>)[input.provenance.taskId]!);}
      if(input.projectId!==project.id)throw new Error('媒体任务工程不匹配');
      const applications=(project.extensions.mediaApplications??{}) as Record<string,{assetIds:string[];revision:number}>;
      const prior=applications[input.provenance.taskId];if(prior)return structuredClone(prior);
      this.assertRevision(input,true);if(input.shotId&&!project.shots.some(shot=>shot.id===input.shotId))throw new Error('媒体任务镜头已不存在');
      const next=structuredClone(project),assetIds:string[]=[];
      for(const file of input.files){
        const asset=await this.store.importAsset(root,{path:file.path,mime:file.mimeType,name:file.name,description:input.provenance.prompt},this.settings);
        Object.assign(asset,{generation:structuredClone(input.provenance)});next.assets.push(asset);assetIds.push(asset.id);next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];
      }
      if(!assetIds.length)throw new Error('媒体任务没有可采用的结果');
      const shot=next.shots.find(item=>item.id===input.shotId);
      if(shot){
        const imageIds=next.assets.filter(asset=>assetIds.includes(asset.id)&&asset.kind==='image').map(asset=>asset.id);shot.assetIds=[...new Set([...shot.assetIds,...imageIds])];
        const video=next.assets.find(asset=>assetIds.includes(asset.id)&&asset.kind==='video');
        if(video){next.schemaVersion=2;next.videoClips=[...(next.videoClips??[]).filter(clip=>clip.shotId!==shot.id),{id:randomUUID(),shotId:shot.id,assetId:video.id,trimStart:0,trimEnd:video.duration,speed:1,fit:'cover',audio:'mute'}];}
      }
      const applied={assetIds,revision:project.revision+1};next.extensions.mediaApplications={...applications,[input.provenance.taskId]:applied};
      await this.persist(next,{},'采用生成媒体',undefined,operation,input.expectedRevision);return structuredClone(applied);
    });
  }
  private required(){if(!this.project||!this.root)throw new Error('请先新建或打开项目');return {project:this.project,root:this.root};}
  private assertIdle(){if(this.task?.status==='running')throw new Error('已有任务运行，请等待或取消');}
  private async refreshPreview(){
    if(!this.project||!this.root)return;
    const project=this.project,root=this.root,revision=project.revision;
    const assetBaseUrl=await this.renderer.assetBaseUrl(root);
    for(const output of project.outputs){output.path=join(root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,assetBaseUrl).href;}
    try{compileSpec(project);}catch{if(this.project===project){this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;}return;}
    const previewUrl=await this.renderer.preview(root,project),audioUrl=await this.renderer.audioPreview(root,project,this.settings);
    // A slower old revision must never overwrite a newer preview's projection.
    if(this.project!==project||this.root!==root)return;
    this.assetBaseUrl=assetBaseUrl;this.previewUrl=previewUrl;this.previewRevision=revision;this.audioUrl=audioUrl;
  }
  private async refreshAfterCommit():Promise<void>{
    try{await this.refreshPreview();}catch(error){
      this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;
      const message=await this.redact(error instanceof Error?error.message:String(error)),now=new Date().toISOString();
      const failed:RecordedTask={id:randomUUID(),kind:'preview',status:'failed',progress:0,message:'工程已保存，预览准备失败：'+message,error:message,startedAt:now,finishedAt:now,revision:this.required().project.revision,appRecordVersion:1,request:this.recordedRequest('preview',{})};
      // A committed edit may fail to preview while export still owns its running task.
      if(this.task?.status!=='running')this.task=failed;
      try{await this.writeTaskJournal(this.required().root,failed);}catch{failed.message+='；任务日志写入失败，请检查工程目录权限';}
    }
  }
  private async persist(next:VideoProject,sources:Record<string,SceneSource>={},label='编辑工程',historyGroup?:string,operation?:CommitOperation,expectedRevision=next.revision){
    const {root}=this.required();next=structuredClone(next);next.revision=expectedRevision+1;this.fitAudio(next);
    this.project=await this.store.commit(root,next,sources,{expectedRevision,label,historyGroup,operation});
    // Rendering follows the durable commit. A preview failure leaves the new version undoable.
    await this.refreshAfterCommit();
  }
  private async apply(data:any){
    this.assertIdle();const {root,project:current}=this.required();
    const incoming=data.project??{};let project=structuredClone(incoming.schemaVersion?incoming:current) as VideoProject;
    if(project.id!==current.id)throw new Error('候选工程 ID 不一致');
    const metadata={...incoming,...data};
    for(const key of ['title','topic'] as const)if(typeof metadata[key]==='string')project[key]=metadata[key];
    if(metadata.targetDuration!==undefined)project.targetDuration=Number(metadata.targetDuration);
    if(metadata.target)project=updateTarget(project,metadata.target);
    if(metadata.graph)project.graph=structuredClone(metadata.graph);
    if(metadata.assets){if(!Array.isArray(metadata.assets))throw new Error('assets须为数组');project.assets=structuredClone(metadata.assets);}
    if(metadata.storyboard){project.shots=normalizeStoryboard(metadata.storyboard,project);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shots){if(!Array.isArray(metadata.shots))throw new Error('shots须为数组');project.shots=structuredClone(metadata.shots);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shotOrder)project=reorderShots(project,metadata.shotOrder);
    for(const item of metadata.shotPatches??[])project=updateShot(project,item.id??item.shotId,item.patch);
    if(metadata.audioClips!==undefined)project.audioClips=structuredClone(metadata.audioClips);
    if(metadata.videoClips!==undefined)project.videoClips=structuredClone(metadata.videoClips);
    if(metadata.sessionIds)project.sessionIds=[...new Set<string>(metadata.sessionIds)];
    if(metadata.extensions)project.extensions={...project.extensions,...metadata.extensions};
    for(const input of data.imports??[]){const asset=await this.store.importAsset(root,input,this.settings);project.assets.push(asset);project.graph.positions[asset.id]=[60,80+(project.assets.length-1)*180];}
    project.revision=current.revision;project.updatedAt=typeof incoming.updatedAt==='string'?incoming.updatedAt:current.updatedAt;this.fitAudio(project);
    const sources=(metadata.sources??[]).map((item:any)=>({shotId:item.shotId,source:parseSceneSource(JSON.stringify(item.source))}));
    const sourceChanges=validateSources(project,sources);
    const validationId=data.validationId??data.operation?.validationId;
    if(validationId){const fullSources:Record<string,SceneSource>={};for(const shot of project.shots)fullSources[shot.id]=sourceChanges[shot.id]??await this.store.readSource(root,shot,Number(data.expectedRevision));const receipt=await readValidation(join(root,'.studio/state.sqlite'),String(validationId));if(!receipt||receipt.status!=='passed'||receipt.candidateHash!==inputHash({project,sources:fullSources}))throw Object.assign(new Error('候选缺少匹配的成功验证回执'),{code:'VALIDATION_REQUIRED'});}
    await this.persist(project,sourceChanges,String(data.label??'应用分镜与源码变更'),undefined,data.operation,Number(data.expectedRevision));
  }
  private fitAudio(project:VideoProject,fitDuration=true):void{
    const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));
    if(project.target.audioMode==='none')return;
    const fps=project.target.fps.num/project.target.fps.den;
    for(const clip of project.audioClips??[]){
      if(clip.role!=='voice'||clip.loop)continue;
      const asset=project.assets.find(a=>a.id===clip.assetId)!;
      const end=clip.startSeconds+Math.min(clip.trimEnd??asset.duration!,asset.duration!)-clip.trimStart;
      if(clip.trimStart>=asset.duration!)throw new Error('旁白裁剪起点超出音频长度');
      if(clip.shotId){
        const shot=project.shots.find(s=>s.id===clip.shotId)!;
        if(end>shot.durationFrames/fps+1e-6){
          if(project.extensions.lockDuration===true||!fitDuration)throw new Error(`旁白超出镜头时长 ${(end-shot.durationFrames/fps).toFixed(2)} 秒，请调整裁剪、旁白或解除时长锁定`);
          shot.durationFrames=Math.ceil((end+.25)*fps);
        }
      }else if(end>project.shots.reduce((sum,s)=>sum+s.durationFrames/fps,0)+1e-6)throw new Error('全片旁白超出成片时长，请延长镜头或裁剪音频');
    }
  }
  private withAudioClip(project:VideoProject,assetId:string,data:any):VideoProject{
    const asset=project.assets.find(a=>a.id===assetId&&a.kind==='audio');if(!asset)throw new Error('请选择音频资产');
    const clip:AudioClip={id:randomUUID(),assetId,role:data.role??'voice',shotId:data.shotId,startSeconds:Number(data.startSeconds??0),trimStart:Number(data.trimStart??0),trimEnd:data.trimEnd,volume:Number(data.volume??1),fadeIn:Number(data.fadeIn??0),fadeOut:Number(data.fadeOut??0),loop:!!data.loop};
    project.audioClips=[...(project.audioClips??[]).filter(c=>!data.replaceVoice||c.role!=='voice'||c.shotId!==clip.shotId),clip];project.target.audioMode='mixed';
    this.fitAudio(project,data.fitDuration!==false);return project;
  }
  private assertRevision(data:any,required=false):void {
    const current=this.required().project;
    if(data.expectedRevision===undefined){
      if(required)throw Object.assign(new Error('修改需要 expectedRevision，请先读取最新工程'),{code:'REVISION_REQUIRED'});
      return;
    }
    if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision!==current.revision)
      throw Object.assign(new Error(`工程版本冲突：期望 v${data.expectedRevision}，当前 v${current.revision}；请读取最新工程后合并修改`),{code:'REVISION_CONFLICT'});
  }
  /** Every externally requested mutation and background commit shares one project queue. */
  private enqueue<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.commands.then(work);this.commands=result.then(()=>undefined,()=>undefined);return result;
  }
  private async speechSettings():Promise<TtsSettings>{
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(this.tts.endpoint==='local:say')return {...this.tts};
    return {...this.tts,apiKey:await this.ctx.credentials.get('YINGLIU_TTS_API_KEY')};
  }
  private async redact(text:string):Promise<string>{
    for(const reference of ['YINGLIU_TTS_API_KEY','yingliu.custom-model.api-key']){try{const key=await this.ctx.credentials.get(reference);if(key)text=text.split(key).join('[redacted]');}catch(error){if(!isCredentialError(error))throw error;}}
    return text.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[redacted]');
  }
  private async writeTaskJournal(root:string,task:RecordedTask):Promise<void>{
    const folder=await projectPath(root,'.studio/tasks');await mkdir(folder,{recursive:true});
    const file=await projectPath(root,`.studio/tasks/${task.id}.json`),temporary=file+'.tmp-'+randomUUID();
    task.logPath=file;task.message=await this.redact(task.message);if(task.error)task.error=await this.redact(task.error);
    if(task.request){task.request=this.recordedRequest(task.request.endpoint,task.request.payload);if(task.request)for(const key of Object.keys(task.request.payload))task.request.payload[key]=await this.redact(task.request.payload[key]!);}
    try{
      const handle=await open(temporary,'w');try{await handle.writeFile(JSON.stringify(task,null,2)+'\n');await handle.sync();}finally{await handle.close();}
      await atomicRename(temporary,file);await syncDirectory(folder);
    }finally{await rm(temporary,{force:true});}
  }
  private recordedRequest(endpoint:string,data:any):TaskRequest|undefined{
    if(!data||typeof data!=='object'||Array.isArray(data))return;
    if(!['preview','export','generate'].includes(endpoint))return;
    const payload:Record<string,string>={};
    if(endpoint==='generate'){
      if(!['storyboard','scenes','modify'].includes(data.kind)||typeof data.provider!=='string'||typeof data.model!=='string')return;
      for(const key of ['kind','provider','model','shotId','instruction'])if(typeof data[key]==='string')payload[key]=data[key].slice(0,key==='instruction'?100000:200);
    }
    return {endpoint:endpoint as TaskRequest['endpoint'],payload};
  }
  private async taskRecords():Promise<RecordedTask[]>{
    const {root}=this.required();let names:string[];
    try{names=await readdir(await projectPath(root,'.studio/tasks'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const tasks:RecordedTask[]=[];
    for(const name of names.filter(name=>/^[a-zA-Z0-9_-]+\.json$/.test(name))){
      try{const value=JSON.parse(await readFile(await projectPath(root,'.studio/tasks/'+name),'utf8')) as RecordedTask;
        if(!value||typeof value!=='object'||value.id+'.json'!==name||typeof value.startedAt!=='string'||!['storyboard','scenes','modify','preview','export','audio'].includes(value.kind)||!['running','complete','failed','cancelled','interrupted'].includes(value.status))continue;
        const task:RecordedTask={ownerPid:Number.isSafeInteger(value.ownerPid)?value.ownerPid:undefined,id:value.id,kind:value.kind,status:value.status,startedAt:value.startedAt,progress:Number.isFinite(value.progress)?value.progress:0,message:await this.redact(String(value.message??'')),logPath:await projectPath(root,'.studio/tasks/'+name),finishedAt:typeof value.finishedAt==='string'?value.finishedAt:undefined,error:typeof value.error==='string'?await this.redact(value.error):undefined,shotId:typeof value.shotId==='string'?value.shotId:undefined,appRecordVersion:value.appRecordVersion===1?1:undefined,revision:Number.isSafeInteger(value.revision)?value.revision:undefined,retryOf:typeof value.retryOf==='string'?value.retryOf:undefined};
        const request=value.appRecordVersion===1&&value.request?this.recordedRequest(value.request.endpoint,value.request.payload):undefined;
        if(request&&((request.endpoint==='preview'||request.endpoint==='export')?request.endpoint===value.kind:request.payload.kind===value.kind)){
          for(const key of Object.keys(request.payload))request.payload[key]=await this.redact(request.payload[key]!);task.request=request;
        }
        if(this.task?.id===task.id&&this.task.status==='running'){task.status='running';task.finishedAt=undefined;task.error=undefined;task.progress=this.task.progress;task.message=await this.redact(this.task.message);}
        tasks.push(task);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    return tasks.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id));
  }
  private async recoverTask():Promise<void>{
    if(!this.root)return;const records=await this.taskRecords();
    for(const task of records)if(task.status==='running'){
      if(task.ownerPid){try{process.kill(task.ownerPid,0);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')continue;}}
      task.status='interrupted';task.message='上次任务已中断 · 请读取当前工程后明确重试';task.error='TASK_INTERRUPTED: 应用退出前任务未完成；请读取当前工程后重试';task.finishedAt=new Date().toISOString();await this.writeTaskJournal(this.root,task);
    }
    this.task=records.find(task=>task.status!=='running'||task.ownerPid===process.pid)??null;
  }
  private async start(kind:TaskState['kind'],work:(signal:AbortSignal)=>Promise<void>,shotId?:string,request?:TaskRequest,retryOf?:string):Promise<void>{
    this.assertIdle();const root=this.required().root;
    const task:RecordedTask={ownerPid:process.pid,id:randomUUID(),kind,status:'running',progress:0,message:'准备中',startedAt:new Date().toISOString(),shotId,appRecordVersion:1,revision:this.required().project.revision,request,retryOf};
    const controller=new AbortController();this.controller=controller;this.task=task;
    try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.error='任务记录保存失败：'+String(error);task.message=task.error;throw error;}
    this.job=(async()=>{
      let status:TaskState['status']='complete',error:string|undefined;
      try{await work(controller.signal);controller.signal.throwIfAborted();}
      catch(failure){status=controller.signal.aborted?'cancelled':'failed';error=failure instanceof Error?failure.message:String(failure);}
      finally{
        const finished:RecordedTask={...task,status,error:error?await this.redact(error):undefined,progress:status==='complete'?1:task.progress,message:status==='complete'?'已完成':status==='cancelled'?'已取消':await this.redact(error??'任务失败'),finishedAt:new Date().toISOString()};
        // Publish completion only after its journal is durable.
        try{await this.writeTaskJournal(root,finished);Object.assign(task,finished);}catch(failure){task.status='failed';task.finishedAt=finished.finishedAt;task.error='任务结束记录保存失败：'+String(failure);task.message=task.error;}
      }
    })();
  }
  private progress(progress:number,message:string){if(this.task?.status==='running'){this.task.progress=progress;this.task.message=message;}}
  private generator(){return new AppSceneGenerator(this.ctx,text=>{if(this.task?.status==='running')this.task.message=`正在生成 · 已收到 ${text.length.toLocaleString()} 字符`;});}
  private patched(project:VideoProject,shotId:string,patch:Partial<Shot>|undefined):VideoProject{
    if(!patch)return project;
    const current=project.shots.find(s=>s.id===shotId);if(!current)return project;
    const safe:Partial<Shot>={};
    for(const key of ['title','intent','composition','action','narration'] as const)if(typeof patch[key]==='string')safe[key]=patch[key];
    if(Number.isInteger(patch.durationFrames)&&patch.durationFrames!>0)safe.durationFrames=patch.durationFrames;
    if(patch.transition==='cut'||patch.transition==='fade')safe.transition=patch.transition;
    const ids=new Set(project.assets.map(a=>a.id));for(const key of ['assetIds','referenceIds'] as const)if(Array.isArray(patch[key]))safe[key]=patch[key]!.filter(id=>ids.has(id));
    if(patch.params&&typeof patch.params==='object')safe.params={...current.params,...patch.params};
    return updateShot(project,shotId,safe);
  }
  private async generateScene(root:string,shotId:string,route:ModelRoute,signal:AbortSignal,instruction?:string,operation?:CommitOperation){
    if(operation){const receipt=await this.store.operationReceipt(root,operation.id);if(receipt){if(receipt.payloadHash!==operation.payloadHash)throw Object.assign(new Error('镜头操作参数不一致'),{code:'OPERATION_CONFLICT'});await this.refreshHead();return;}}
    await this.refreshHead();const generator=this.generator(),initial=structuredClone(this.required().project),shot=initial.shots.find(s=>s.id===shotId);if(!shot)throw new Error('镜头已不存在');
    const sources:Record<string,SceneSource>={};for(const item of initial.shots)sources[item.id]=await this.store.readSource(root,item,initial.revision);
    signal.throwIfAborted();let source=await generator.scene(initial,shot,route,signal,instruction?sources[shotId]:undefined,instruction);
    for(let attempt=0;attempt<3;attempt++){
      signal.throwIfAborted();const next=this.patched(structuredClone(initial),shotId,source.shotPatch);next.revision=initial.revision;
      const candidate={project:next,sources:{...sources,[shotId]:{html:source.html,css:source.css,js:source.js}}};this.fitAudio(next);
      const checked=await this.validateCandidate(candidate,signal);
      if(checked.status==='passed'){
        await this.enqueue(async()=>{signal.throwIfAborted();await this.persist(next,{[shotId]:candidate.sources[shotId]!},'模型生成镜头',this.task?.id,operation,initial.revision);});
        return;
      }
      const errors=checked.checks.filter(check=>check.status==='failed');if(attempt===2)throw new Error(errors.map(error=>error.message).join('\n'));
      this.progress(this.task?.progress??0,'候选检查失败，正在修复');
      source=await generator.scene(initial,shot,route,signal,source,'修复候选验证错误，保留当前设计和可编辑参数：'+JSON.stringify(errors));
    }
  }
  async rpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    await this.initialized;
    if(endpoint==='cancel'){
      const data=(payload??{}) as {expectedTaskId?:string};
      if(!data.expectedTaskId)return {ok:false,error:{code:'TASK_ID_REQUIRED',message:'取消需要 expectedTaskId，请读取当前任务后重试'}};
      // Compare and abort synchronously; no await may redirect cancellation to another task.
      if(data.expectedTaskId!==this.task?.id)return {ok:false,error:{code:'TASK_CONFLICT',message:'目标任务已变化，取消请求未执行'}};
      this.controller?.abort(new Error('用户已取消'));return {ok:true,value:await this.snapshot()};
    }
    return this.enqueue(()=>this.performRpc(endpoint,payload));
  }
  private async performRpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('应用服务已停止');await this.refreshHead();const data=(payload??{}) as any;
      const operation:CommitOperation|undefined=['operation.get','operation.receipt','operation.intent'].includes(endpoint)?undefined:typeof data.operation==='object'&&data.operation?data.operation:typeof data.operationId==='string'?{id:data.operationId,payloadHash:inputHash({endpoint,payload:{...data,operationId:undefined}})}:undefined;
      if(operation&&this.root){const prior=await this.store.operationReceipt(this.root,operation.id);if(prior){if(prior.payloadHash!==operation.payloadHash)throw Object.assign(new Error('operationId 已用于不同参数'),{code:'OPERATION_CONFLICT'});const snapshot=await this.snapshot();snapshot.project=await this.store.readProject(this.root,prior.committedRevision);return {ok:true,value:{...snapshot,operationReceipt:prior}};}}
      const persist=(next:VideoProject,sources:Record<string,SceneSource>={},label='编辑工程',historyGroup?:string)=>this.persist(next,sources,label,historyGroup,operation,Number(data.expectedRevision??next.revision));
      if(['save','apply','applyOperation','import','audio','generate','saveSource','restoreSource','undo','redo','rename','retry','job.retry','video.clip.save','video.clip.remove','video.clip.extract'].includes(endpoint))this.assertRevision(data,true);
      else if(['import','audio','generate','export','preview'].includes(endpoint)&&data.expectedRevision!==undefined)this.assertRevision(data);
      switch(endpoint){
        case 'catalog':this.providers=await Promise.all(this.ctx.llm.listProviders().map(async p=>{try{return {...p,models:await this.ctx.llm.listModels(p.id)};}catch(error){return {...p,models:[],error:error instanceof Error?error.message:'模型目录读取失败'};}}));break;
        case 'current':break;
        case 'operation.intent':return {ok:true,value:await readExternalOperation(await this.databasePath(),String(data.operationId??data.id))};
        case 'operation.get':case 'operation.receipt':return {ok:true,value:await this.store.operationReceipt(this.required().root,String(data.operationId??data.id))};
        case 'create':{
          this.assertIdle();let project:VideoProject;
          if(data.project){project=structuredClone(data.project);validateStoredProject(project);validateSources(project,data.sources??[]);for(const item of data.sources??[])parseSceneSource(JSON.stringify(item.source));}
          else{
            project=createProject(String(data.title||'未命名视频'),String(data.topic||''));if(operation)project.id='film_'+inputHash({operationId:operation.id}).slice(0,32);if(data.target)project=updateTarget(project,data.target);if(data.targetDuration!==undefined)project.targetDuration=Number(data.targetDuration);
            if(data.videoStyle!==undefined)project.videoStyle=normalizeVideoStyle(data.videoStyle);
            if(data.blank===true){project.shots=[];project.shotOrder=[];project.graph={positions:{'film-output':[375,140]},groups:[]};project.extensions.graphEdges=[];}
            project.extensions.brief={profile:String(data.profile??''),preset:String(data.preset??'')};
          }
          this.fitAudio(project);
          if(data.validationId){const sources=Object.fromEntries((data.sources??[]).map((item:any)=>[item.shotId,item.source]));for(const shot of project.shots)if(!sources[shot.id])sources[shot.id]=defaultSceneSource();const receipt=await readValidation(join(this.baseDirectory,'agent-state.sqlite'),String(data.validationId));if(!receipt||receipt.status!=='passed'||receipt.candidateHash!==inputHash({project,sources}))throw Object.assign(new Error('新工程缺少匹配的成功验证回执'),{code:'VALIDATION_REQUIRED'});}
          const created=await this.store.create({project,sources:data.sources??[],assetFiles:data.assetFiles??[]},operation);this.root=created.root;this.project=created.project;this.task=null;
          if(!data.project)for(const shot of this.project.shots)await this.store.markSourceGood(this.root,shot).catch(()=>{});await this.refreshAfterCommit();break;
        }
        case 'open':{this.assertIdle();const root=resolve(String(data.path)),project=await this.store.open(root);this.root=root;this.project=project;this.task=null;await this.recoverTask();await this.refreshAfterCommit();break;}
        case 'save':{if(this.task?.status==='running'&&this.task.kind!=='export')this.assertIdle();const {project}=this.required();if(!data.project||data.project.id!==project.id)throw new Error('项目已切换，请刷新后重试');const next=structuredClone(data.project) as VideoProject;this.fitAudio(next);await persist({...next,outputs:project.outputs}, {},'保存工程');break;}
        case 'apply':case 'applyOperation':await this.apply({...data,operation});break;
        case 'candidate.validate':{const candidate=data.candidate?.project?data.candidate:{project:data.candidate,sources:Object.fromEntries((data.sources??[]).map((item:any)=>[item.shotId,item.source]))};if(data.projectId)this.assertRevision(data,true);return {ok:true,value:await this.validateCandidate(candidate,data.signal)};}
        case 'import':{this.assertIdle();const {root,project}=this.required();const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);next.graph.positions[asset.id]=[60,80+(next.assets.length-1)*180];await persist(next,{},'导入素材');break;}
        case 'video.clip.save':{
          this.assertIdle();const next=structuredClone(this.required().project),raw=data.clip;
          if(!raw||typeof raw!=='object'||!['mute','keep'].includes(raw.audio??'mute'))throw new Error('视频片段参数无效');
          if(!next.shots.some(shot=>shot.id===raw.shotId)||!next.assets.some(asset=>asset.id===raw.assetId&&asset.kind==='video'))throw new Error('请选择当前工程的视频素材和镜头');
          const existing=(next.videoClips??[]).find(clip=>clip.shotId===raw.shotId);
          if(raw.id&&raw.id!==existing?.id)throw new Error('视频片段已变化，请刷新');
          const clip:VideoClip={id:existing?.id??randomUUID(),shotId:raw.shotId,assetId:raw.assetId,trimStart:Number(raw.trimStart??0),...(raw.trimEnd!==undefined?{trimEnd:Number(raw.trimEnd)}:{}),speed:Number(raw.speed??1),fit:raw.fit??'cover',audio:raw.audio??'mute'};
          next.schemaVersion=2;next.videoClips=[...(next.videoClips??[]).filter(item=>item.shotId!==clip.shotId),clip];if(clip.audio==='keep')next.target.audioMode='mixed';await persist(next,{},'保存视频片段');break;
        }
        case 'video.clip.remove':{
          this.assertIdle();const next=structuredClone(this.required().project);if(!next.videoClips?.some(clip=>clip.id===data.clipId))throw new Error('视频片段不存在');
          next.videoClips=next.videoClips.filter(clip=>clip.id!==data.clipId);await persist(next,{},'移除视频片段');break;
        }
        case 'video.clip.extract':{
          this.assertIdle();const {root,project}=this.required(),next=structuredClone(project),clip=next.videoClips?.find(item=>item.id===data.clipId);
          if(!clip)throw new Error('视频片段不存在');const video=next.assets.find(asset=>asset.id===clip.assetId)!;
          const audio=await extractVideoAudio(root,video,clip,this.settings);next.assets.push(audio);clip.audio='mute';
          const shot=next.shots.find(item=>item.id===clip.shotId)!;
          next.audioClips=[...(next.audioClips??[]),{id:randomUUID(),assetId:audio.id,role:'sfx',shotId:clip.shotId,startSeconds:0,trimStart:0,trimEnd:Math.min(audio.duration!,shot.durationFrames*next.target.fps.den/next.target.fps.num),volume:1,fadeIn:0,fadeOut:0}];next.target.audioMode='mixed';await persist(next,{},'提取视频原声');break;
        }
        case 'tts':{
          this.assertIdle();const options:Partial<TtsSettings>={};for(const key of ['endpoint','model','voice','speed','enabled'] as const)if(data[key]!==undefined)(options as any)[key]=data[key];
          const next={...this.tts,...options},file=join(this.baseDirectory,'tts.json'),temporary=file+'.tmp-'+randomUUID();
          const onlyClearingKey=data.apiKey!==undefined&&!String(data.apiKey).trim()&&!Object.keys(options).length;
          if(!onlyClearingKey)validateTtsSettings(next,detectEnvironment(this.settings));
          const commit=async()=>{await mkdir(this.baseDirectory,{recursive:true});await writeFile(temporary,JSON.stringify(next,null,2));await atomicRename(temporary,file);this.tts=next;};
          try{if(data.apiKey===undefined)await commit();else await updateCredential(this.ctx.credentials,'YINGLIU_TTS_API_KEY',String(data.apiKey).trim()||undefined,commit);}
          finally{await rm(temporary,{force:true});}break;
        }
        case 'audio':{
          this.assertIdle();const {root,project}=this.required(),audioAction=typeof data.operation==='string'?data.operation:data.action;
          if(audioAction==='synthesize'||audioAction==='tts'){
            if(operation)await reserveExternalOperation(join(root,'.studio/state.sqlite'),operation,'speech');
            const shot=project.shots.find(s=>s.id===data.shotId);const text=String(data.text??shot?.narration??'').trim();if(!text)throw new Error('请先填写旁白');
            await this.start('audio',async signal=>{this.progress(.1,'生成配音');const asset=await this.speech.synthesize(root,{text,name:shot?shot.title+' · 配音':'配音'},await this.speechSettings(),this.settings,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const next=structuredClone(this.required().project);next.assets.push(asset);const currentShot=next.shots.find(s=>s.id===data.shotId);if(currentShot)currentShot.narration=text;await persist(this.withAudioClip(next,asset.id,{...data,role:'voice',replaceVoice:true}),{},'生成配音');});},data.shotId);
          }else if(audioAction==='add'||audioAction==='bind'){await persist(this.withAudioClip(structuredClone(project),data.assetId??data.clip?.assetId,{...data,...data.clip}),{},'添加音轨');}
          else if(audioAction==='update'){const next=structuredClone(project),clip=next.audioClips?.find(c=>c.id===data.clipId);if(!clip)throw new Error('音频片段不存在');Object.assign(clip,data.patch);this.fitAudio(next,data.fitDuration!==false);await persist(next,{},audioAction==='update'?'修改音轨':'删除音轨');}
          else if(audioAction==='remove'){const next=structuredClone(project);next.audioClips=next.audioClips?.filter(c=>c.id!==data.clipId);await persist(next,{},audioAction==='update'?'修改音轨':'删除音轨');}
          else if(audioAction==='import'){const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);await persist(this.withAudioClip(next,asset.id,data),{},'导入音频');}
          else throw new Error('音频操作无效');break;
        }
        case 'inspect':{const {root,project}=this.required();const spec=compileSpec(project);const shot=project.shots.find(s=>s.id===data.shotId);const source=shot&&data.includeSource?await this.store.readSource(root,shot,project.revision):undefined;let frame;
          if(data.frame!==undefined)frame=await this.renderer.capture(root,project,this.settings,Number(data.frame),data.signal instanceof AbortSignal?data.signal:undefined);
          return {ok:true,value:{projectId:project.id,revision:project.revision,spec,source,frame}};
        }
        case 'source':{const {root,project:current}=this.required();const project=data.revision===undefined?current:await this.store.readProject(root,data.revision);const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');return {ok:true,value:await this.store.readSource(root,shot,project.revision)};}
        case 'saveSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=parseSceneSource(JSON.stringify(data.source));await persist(project,{[shot.id]:source},'保存镜头源码');await this.start('preview',async signal=>{const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));await this.store.markSourceGood(root,shot);},shot.id,this.recordedRequest('preview',data));break;}
        case 'restoreSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=await this.store.restorationSource(root,shot);await persist(project,{[shot.id]:source},'恢复镜头源码');break;}
        case 'preview':{const {root,project}=this.required();compileSpec(project);await this.start('preview',async signal=>{await this.refreshPreview();signal.throwIfAborted();this.progress(.1,'检查资源与关键帧');const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));for(const shot of this.required().project.shots)await this.store.markSourceGood(root,shot);},undefined,this.recordedRequest('preview',data),data._retryOf);break;}
        case 'generate':{
          const {root,project}=this.required(),route={provider:String(data.provider??''),model:String(data.model??'')},kind=data.kind as 'storyboard'|'scenes'|'modify';if(!['storyboard','scenes','modify'].includes(kind))throw new Error('生成类型无效');
          if(operation)await reserveExternalOperation(join(root,'.studio/state.sqlite'),operation,'generate');
          await this.start(kind,async signal=>{
            if(kind==='storyboard'){
              const shots=await this.generator().storyboard(structuredClone(project),route,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:project.revision});const current=structuredClone(this.required().project);
              current.shots=shots;current.shotOrder=shots.map(s=>s.id);delete current.extensions.graphEdges;current.revision++;
              for(let i=0;i<shots.length;i++)current.graph.positions[shots[i]!.id]=[420+i*340,160];current.graph.positions['film-output']=[420+shots.length*340,160];await persist(current,Object.fromEntries(shots.map(s=>[s.id,defaultSceneSource()])),'模型生成分镜',this.task?.id);});
            }else{
              compileSpec(this.required().project);const ids=data.shotId?[String(data.shotId)]:[...this.required().project.shotOrder];
              for(let i=0;i<ids.length;i++){signal.throwIfAborted();this.progress(i/ids.length,`生成镜头 ${i+1}/${ids.length}`);await this.generateScene(root,ids[i]!,route,signal,kind==='modify'?String(data.instruction??'改进画面与动作，保留内容'):undefined,operation?(i===ids.length-1?operation:{...operation,id:'scene:'+inputHash({operationId:operation.id,shotId:ids[i]}),payloadHash:inputHash({parent:operation.payloadHash,shotId:ids[i]})}):undefined);}
            }
          },data.shotId,this.recordedRequest('generate',data),data._retryOf);break;
        }
        case 'export':{const {root,project}=this.required();compileSpec(project);const snapshot=structuredClone(project);await this.start('export',async signal=>{const result=await this.renderer.export(root,snapshot,this.settings,signal,(p,m)=>this.progress(p,m));signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();
          // Export output belongs to its frozen input revision, while the receipt is appended to the latest HEAD.
          for(let attempt=0;attempt<3;attempt++){const current=await this.store.readProject(root);if(current.outputs.some(output=>output.id===result.id))break;current.outputs.push(result);try{await this.persist(current,{},'导出成片记录',undefined,operation,current.revision);break;}catch(error){if((error as {code?:string}).code!=='REVISION_CONFLICT'||attempt===2)throw error;}}
          if(!result.url&&this.assetBaseUrl)result.url=new URL(relative(root,result.path).split('/').map(encodeURIComponent).join('/'),this.assetBaseUrl).href;});},undefined,this.recordedRequest('export',data),data._retryOf);break;}
        case 'history':return {ok:true,value:await this.store.history(this.required().root)};
        case 'undo':case 'redo':{this.assertIdle();this.project=await this.store.moveHistory(this.required().root,endpoint,data.expectedRevision,operation);await this.refreshAfterCommit();break;}
        case 'rename':{this.assertIdle();if(typeof data.title!=='string'||!data.title.trim())throw new Error('工程名称不能为空');const next=structuredClone(this.required().project);next.title=data.title.trim();await persist(next,{},'重命名工程');break;}
        case 'duplicate':{this.assertIdle();if(data.expectedRevision!==undefined)this.assertRevision(data);return {ok:true,value:await this.store.duplicate(this.required().root,data.title)};}
        case 'tasks':case 'jobs':{const tasks=await this.taskRecords();return {ok:true,value:{tasks:tasks.map(task=>({...task,retryable:!!task.request&&task.status!=='running'&&task.status!=='complete'&&task.request.endpoint!=='generate'}))}};}
        case 'retry':case 'job.retry':{
          this.assertIdle();const task=(await this.taskRecords()).find(task=>task.id===data.taskId);
          if(!task||!task.request||task.status==='running')throw new Error('此任务没有可重试的本应用请求记录');
          if(task.status==='complete')throw Object.assign(new Error('任务已完成；撤销不会重置成功操作，不能通过重试重新生成'),{code:'TASK_ALREADY_COMPLETED'});
          if(task.request.endpoint==='generate')throw Object.assign(new Error('生成请求可能已提交，需对账或验证已有产物；禁止自动重放供应商调用'),{code:'OPERATION_UNRESOLVED'});
          return this.performRpc(task.request.endpoint,{...task.request.payload,expectedRevision:data.expectedRevision,_retryOf:task.id,...(operation?{operation}:{})});
        }
        case 'environment':this.assertIdle();if(data.maxVideoBytes!==undefined){if(!Number.isSafeInteger(data.maxVideoBytes)||data.maxVideoBytes<1||data.maxVideoBytes>512*1024*1024)throw new Error('单个视频文件上限须为 1 字节至 512 MiB');this.settings.maxVideoBytes=data.maxVideoBytes;}for(const key of ['browserPath','ffmpegPath','ffprobePath'] as const)if(data[key]!==undefined){if(typeof data[key]!=='string')throw new Error('执行文件路径须为字符串');this.settings[key]=data[key];}await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'environment.json'),JSON.stringify(this.settings,null,2));break;
        case 'reveal':{const {root}=this.required(),target=await projectOpenPath(root,String(data.path??root));if(!this.ctx.reveal)throw new Error('当前运行器没有文件打开服务');await this.ctx.reveal(target);break;}
        default:throw new Error('未找到应用操作');
      }
      const snapshot=await this.snapshot();const receipt=operation&&this.root?await this.store.operationReceipt(this.root,operation.id):undefined;
      return {ok:true,value:receipt?{...snapshot,operationReceipt:receipt}:snapshot};
    }catch(error){return {ok:false,error:{code:error instanceof Error&&'code' in error?String(error.code):'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){this.disposed=true;this.controller?.abort(new Error('应用已停止'));await this.commands;await this.job;await this.commands;await this.speech.close();await this.renderer.close();}
}
