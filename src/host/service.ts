import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {homedir} from 'node:os';
import {createProject,compileSpec,defaultSceneSource,updateShot,updateTarget,validateProject,reorderShots} from '../core/index.ts';
import type {VideoProject,StudioSnapshot,TaskState,EnvironmentSettings,ProviderGroup,RpcResult,SceneSource,Shot,ModelRoute,TtsSettings,AudioClip} from '../shared/types.ts';
import type {HostContext} from './platform.ts';
import {ProjectStore,projectPath} from './store.ts';
import {VideoRenderer,detectEnvironment} from './renderer.ts';
import {AppSceneGenerator,parseSceneSource,normalizeStoryboard} from './generator.ts';
import {SpeechSynthesizer} from './audio.ts';

export class StudioService {
  readonly store:ProjectStore;readonly renderer=new VideoRenderer();
  private project:VideoProject|null=null;private root:string|null=null;
  private task:TaskState|null=null;private controller?:AbortController;private job?:Promise<void>;
  private commands:Promise<unknown>=Promise.resolve();
  private providers:ProviderGroup[]=[];private previewUrl:string|null=null;private previewRevision:number|null=null;private assetBaseUrl:string|null=null;
  private settings:EnvironmentSettings;private initialized:Promise<void>;private disposed=false;
  private readonly baseDirectory:string;
  private readonly restoreRecent:boolean;
  private readonly speech=new SpeechSynthesizer();
  private audioUrl:string|null=null;
  private tts:TtsSettings={endpoint:'local:say',model:'',voice:'',speed:1,enabled:false};
  constructor(private ctx:HostContext,config:{baseDirectory?:string;restoreRecent?:boolean}={}){
    this.baseDirectory=resolve(config.baseDirectory??process.env.YINGLIU_PROJECTS??join(homedir(),'Documents','YingliuProjects'));
    this.restoreRecent=config.restoreRecent!==false;
    this.store=new ProjectStore({baseDirectory:this.baseDirectory});
    const env=detectEnvironment();this.settings={browserPath:env.browserPath,ffmpegPath:env.ffmpegPath,ffprobePath:env.ffprobePath};
    this.initialized=this.initialize();
  }
  private async initialize(){
    try{this.settings={...this.settings,...JSON.parse(await readFile(join(this.baseDirectory,'environment.json'),'utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{this.tts={...this.tts,...JSON.parse(await readFile(join(this.baseDirectory,'tts.json'),'utf8'))};delete this.tts.apiKey;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const recent=this.restoreRecent?await this.store.recent():[];
    if(recent[0])try{this.project=await this.store.open(recent[0].path);this.root=recent[0].path;await this.recoverTask();await this.refreshPreview();}catch{/* Recent path may have been moved; keep the picker usable. */}
  }
  async snapshot():Promise<StudioSnapshot>{await this.initialized;const credentials=this.ctx.credentials;return structuredClone({project:this.project,root:this.root,task:this.task,previewUrl:this.previewUrl,previewRevision:this.previewRevision,assetBaseUrl:this.assetBaseUrl,audioUrl:this.audioUrl,tts:{...this.tts,apiKey:undefined},ttsConfigured:!!(await credentials.get('YINGLIU_TTS_API_KEY')),providers:this.providers,environment:detectEnvironment(this.settings),recent:await this.store.recent()});}
  private required(){if(!this.project||!this.root)throw new Error('请先新建或打开项目');return {project:this.project,root:this.root};}
  private assertIdle(){if(this.task?.status==='running')throw new Error('已有任务运行，请等待或取消');}
  private async refreshPreview(){
    if(!this.project||!this.root)return;
    for(const shot of this.project.shots){
      try{await this.store.readSource(this.root,shot);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
        const origin=(this.project.extensions.sourceCopies as Record<string,string>|undefined)?.[shot.id];
        const source=origin?await this.store.readSource(this.root,origin):defaultSceneSource();
        await this.store.writeSource(this.root,shot,source);if(!origin)await this.store.markSourceGood(this.root,shot);
      }
    }
    this.assetBaseUrl=await this.renderer.assetBaseUrl(this.root);
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.assetBaseUrl).href;}
    try{compileSpec(this.project);}catch{this.previewUrl=null;this.previewRevision=null;this.audioUrl=null;return;}
    this.previewUrl=await this.renderer.preview(this.root,this.project);this.previewRevision=this.project.revision;
    this.audioUrl=await this.renderer.audioPreview(this.root,this.project,this.settings);
    for(const output of this.project.outputs){output.path=join(this.root,'exports',output.id,'video.mp4');output.url=new URL(`exports/${encodeURIComponent(output.id)}/video.mp4`,this.previewUrl).href;}
  }
  private async persist(){const {root,project}=this.required();this.project=await this.store.save(root,project);await this.refreshPreview();}
  private async apply(data:any){
    this.assertIdle();const {root,project:current}=this.required();let project=structuredClone(current);
    const incoming=data.project??{};
    const metadata={...incoming,...data};
    for(const key of ['title','topic'] as const)if(typeof metadata[key]==='string')project[key]=metadata[key];
    if(metadata.targetDuration!==undefined)project.targetDuration=Number(metadata.targetDuration);
    if(metadata.target)project=updateTarget(project,metadata.target);
    if(metadata.assets){if(!Array.isArray(metadata.assets))throw new Error('assets须为数组');project.assets=structuredClone(metadata.assets);}
    if(metadata.storyboard){project.shots=normalizeStoryboard(metadata.storyboard,project);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shots){if(!Array.isArray(metadata.shots))throw new Error('shots须为数组');project.shots=structuredClone(metadata.shots);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;}
    if(metadata.shotOrder)project=reorderShots(project,metadata.shotOrder);
    for(const item of metadata.shotPatches??[])project=updateShot(project,item.id??item.shotId,item.patch);
    if(metadata.audioClips!==undefined)project.audioClips=structuredClone(metadata.audioClips);
    if(metadata.sessionIds)project.sessionIds=[...new Set<string>(metadata.sessionIds)];
    if(metadata.extensions)project.extensions={...project.extensions,...metadata.extensions};
    this.fitAudio(project);
    const sources=(metadata.sources??[]).map((item:any)=>{const shot=project.shots.find(s=>s.id===item.shotId);if(!shot)throw new Error('源码引用的镜头不存在');return {shot,source:parseSceneSource(JSON.stringify(item.source))};});
    for(const {shot,source} of sources)await this.store.writeSource(root,shot,source);
    project.revision=current.revision+1;this.project=project;await this.persist();
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
    this.fitAudio(project,data.fitDuration!==false);project.revision++;return project;
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
    return {...this.tts,apiKey:await this.ctx.credentials.get('YINGLIU_TTS_API_KEY')};
  }
  private async writeTaskJournal(root:string,task:TaskState):Promise<void>{
    const folder=await projectPath(root,'.studio/tasks');await mkdir(folder,{recursive:true});
    const file=await projectPath(root,`.studio/tasks/${task.id}.json`),temporary=file+'.tmp';
    task.logPath=file;await writeFile(temporary,JSON.stringify(task,null,2)+'\n');await rename(temporary,file);
  }
  private async recoverTask():Promise<void>{
    if(!this.root)return;
    const folder=await projectPath(this.root,'.studio/tasks');let names:string[];
    try{names=await readdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    const records:TaskState[]=[];
    for(const name of names.filter(name=>/^[a-zA-Z0-9_-]+\.json$/.test(name))){
      try{
        const task=JSON.parse(await readFile(await projectPath(this.root,'.studio/tasks/'+name),'utf8')) as TaskState;
        if(typeof task.id!=='string'||name!==task.id+'.json'||typeof task.startedAt!=='string'||!['running','complete','failed','cancelled'].includes(task.status))continue;
        if(task.status==='running'){
          task.status='failed';task.message='上次任务已中断 · 可重新运行';task.error='TASK_INTERRUPTED: 应用退出前任务未完成；请读取当前工程后重试';task.finishedAt=new Date().toISOString();
          await this.writeTaskJournal(this.root,task);
        }
        records.push(task);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    }
    records.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));this.task=records[0]??null;
  }
  private async start(kind:TaskState['kind'],work:(signal:AbortSignal)=>Promise<void>,shotId?:string):Promise<void>{
    this.assertIdle();const root=this.required().root;
    const task:TaskState={id:randomUUID(),kind,status:'running',progress:0,message:'准备中',startedAt:new Date().toISOString(),shotId};
    const controller=new AbortController();this.controller=controller;this.task=task;
    try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.error='任务记录保存失败：'+String(error);task.message=task.error;throw error;}
    this.job=(async()=>{
      try{await work(controller.signal);controller.signal.throwIfAborted();task.status='complete';task.progress=1;task.message='已完成';}
      catch(error){task.status=controller.signal.aborted?'cancelled':'failed';task.error=error instanceof Error?error.message:String(error);task.message=task.status==='cancelled'?'已取消':task.error;}
      finally{
        task.finishedAt=new Date().toISOString();
        try{await this.writeTaskJournal(root,task);}catch(error){task.status='failed';task.error='任务结束记录保存失败：'+String(error);task.message=task.error;}
      }
    })();
  }
  private progress(progress:number,message:string){if(this.task?.status==='running'){this.task.progress=progress;this.task.message=message;}}
  private generator(){return new AppSceneGenerator(this.ctx,text=>{if(this.task?.status==='running')this.task.message=`正在生成 · 已收到 ${text.length.toLocaleString()} 字符`;});}
  private applyPatch(shotId:string,patch:Partial<Shot>|undefined){
    if(!patch||!this.project)return;
    const current=this.project.shots.find(s=>s.id===shotId);if(!current)return;
    const safe:Partial<Shot>={};
    for(const key of ['title','intent','composition','action','narration'] as const)if(typeof patch[key]==='string')safe[key]=patch[key];
    if(Number.isInteger(patch.durationFrames)&&patch.durationFrames!>0)safe.durationFrames=patch.durationFrames;
    if(patch.transition==='cut'||patch.transition==='fade')safe.transition=patch.transition;
    const ids=new Set(this.project.assets.map(a=>a.id));for(const key of ['assetIds','referenceIds'] as const)if(Array.isArray(patch[key]))safe[key]=patch[key]!.filter(id=>ids.has(id));
    if(patch.params&&typeof patch.params==='object')safe.params={...current.params,...patch.params};
    this.project=updateShot(this.project,shotId,safe);
  }
  private async generateScene(root:string,shotId:string,route:ModelRoute,signal:AbortSignal,instruction?:string){
    const generator=this.generator(),initial=structuredClone(this.required().project),shot=initial.shots.find(s=>s.id===shotId);if(!shot)throw new Error('镜头已不存在');
    const old=await this.store.readSource(root,shot);const source=await generator.scene(initial,shot,route,signal,instruction?old:undefined,instruction);
    signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();this.assertRevision({expectedRevision:initial.revision});this.applyPatch(shotId,source.shotPatch);await this.store.writeSource(root,shot,{html:source.html,css:source.css,js:source.js});this.required().project.revision=Math.max(this.required().project.revision,initial.revision)+1;await this.persist();});
    let checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    if(!checked.ok){
      this.progress(this.task?.progress??0,'发现代码错误，正在修复');
      const errors=checked.errors.filter(e=>!e.shotId||e.shotId===shotId);if(!errors.length)throw new Error(checked.errors.map(e=>e.message).join('\n'));
      const repaired=await generator.scene(this.required().project,this.required().project.shots.find(s=>s.id===shotId)!,route,signal,source,`修复运行错误，保留当前设计和可编辑参数：${JSON.stringify(errors)}`);
      signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();await this.store.writeSource(root,shot,{html:repaired.html,css:repaired.css,js:repaired.js});this.required().project.revision++;await this.persist();});checked=await this.renderer.check(root,this.required().project,this.settings,signal);
    }
    if(!checked.ok)throw new Error(checked.errors.map(e=>`镜头 ${e.shotId??shotId} 帧 ${e.frame??'?'}：${e.message}`).join('\n'));
    await this.enqueue(()=>this.store.markSourceGood(root,shot));
  }
  async rpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    await this.initialized;
    if(endpoint==='cancel'){this.controller?.abort(new Error('用户已取消'));return {ok:true,value:await this.snapshot()};}
    return this.enqueue(()=>this.performRpc(endpoint,payload));
  }
  private async performRpc(endpoint:string,payload:unknown):Promise<RpcResult>{
    try{
      await this.initialized;if(this.disposed)throw new Error('应用服务已停止');const data=(payload??{}) as any;
      if(['save','apply','saveSource','restoreSource'].includes(endpoint))this.assertRevision(data,true);
      else if(['import','audio','generate','export','preview'].includes(endpoint)&&data.expectedRevision!==undefined)this.assertRevision(data);
      switch(endpoint){
        case 'catalog':this.providers=await Promise.all(this.ctx.llm.listProviders().map(async p=>{try{return {...p,models:await this.ctx.llm.listModels(p.id)};}catch(error){return {...p,models:[],error:error instanceof Error?error.message:'模型目录读取失败'};}}));break;
        case 'current':break;
        case 'create':{this.assertIdle();let project=createProject(String(data.title||'未命名视频'),String(data.topic||''));if(data.target)project=updateTarget(project,data.target);if(data.targetDuration!==undefined)project.targetDuration=Number(data.targetDuration);if(data.blank===true){project.shots=[];project.shotOrder=[];project.graph={positions:{'film-output':[375,140]},groups:[]};project.extensions.graphEdges=[];}const created=await this.store.create(project);this.root=created.root;this.project=created.project;this.task=null;for(const shot of this.project.shots)await this.store.markSourceGood(this.root,shot);await this.persist();break;}
        case 'open':this.assertIdle();this.root=resolve(String(data.path));this.project=await this.store.open(this.root);this.task=null;await this.recoverTask();await this.refreshPreview();break;
        case 'save':{if(this.task?.status==='running'&&this.task.kind!=='export')this.assertIdle();const {project}=this.required();if(!data.project||data.project.id!==project.id)throw new Error('项目已切换，请刷新后重试');const next=structuredClone(data.project) as VideoProject;this.fitAudio(next);this.project={...next,outputs:project.outputs,revision:project.revision+1,updatedAt:new Date().toISOString()};await this.persist();break;}
        case 'apply':await this.apply(data);break;
        case 'import':{this.assertIdle();const {root,project}=this.required();const asset=await this.store.importAsset(root,data,this.settings);project.assets.push(asset);project.graph.positions[asset.id]=[60,80+(project.assets.length-1)*180];project.revision++;await this.persist();break;}
        case 'tts':{this.assertIdle();const options:Partial<TtsSettings>={};for(const key of ['endpoint','model','voice','speed','enabled'] as const)if(data[key]!==undefined)(options as any)[key]=data[key];if(data.apiKey!==undefined){const credentials=this.ctx.credentials;if(data.apiKey){if(!credentials)throw new Error('宿主凭据服务不可用，请使用本地配音或无密钥端点');await credentials.set('YINGLIU_TTS_API_KEY',String(data.apiKey));}else await credentials.delete('YINGLIU_TTS_API_KEY');}this.tts={...this.tts,...options};await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'tts.json'),JSON.stringify(this.tts,null,2));break;}
        case 'audio':{
          this.assertIdle();const {root,project}=this.required(),operation=data.operation??data.action;
          if(operation==='synthesize'||operation==='tts'){
            const shot=project.shots.find(s=>s.id===data.shotId);const text=String(data.text??shot?.narration??'').trim();if(!text)throw new Error('请先填写旁白');
            await this.start('audio',async signal=>{this.progress(.1,'生成配音');const asset=await this.speech.synthesize(root,{text,name:shot?shot.title+' · 配音':'配音'},await this.speechSettings(),this.settings,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const next=structuredClone(this.required().project);next.assets.push(asset);const currentShot=next.shots.find(s=>s.id===data.shotId);if(currentShot)currentShot.narration=text;this.project=this.withAudioClip(next,asset.id,{...data,role:'voice',replaceVoice:true});await this.persist();});},data.shotId);
          }else if(operation==='add'||operation==='bind'){this.project=this.withAudioClip(structuredClone(project),data.assetId??data.clip?.assetId,{...data,...data.clip});await this.persist();}
          else if(operation==='update'){const next=structuredClone(project),clip=next.audioClips?.find(c=>c.id===data.clipId);if(!clip)throw new Error('音频片段不存在');Object.assign(clip,data.patch);this.fitAudio(next,data.fitDuration!==false);next.revision++;this.project=next;await this.persist();}
          else if(operation==='remove'){const next=structuredClone(project);next.audioClips=next.audioClips?.filter(c=>c.id!==data.clipId);next.revision++;this.project=next;await this.persist();}
          else if(operation==='import'){const asset=await this.store.importAsset(root,data,this.settings);const next=structuredClone(project);next.assets.push(asset);this.project=this.withAudioClip(next,asset.id,data);await this.persist();}
          else throw new Error('音频操作无效');break;
        }
        case 'inspect':{const {root,project}=this.required();const spec=compileSpec(project);const shot=project.shots.find(s=>s.id===data.shotId);const source=shot&&data.includeSource?await this.store.readSource(root,shot):undefined;let frame;
          if(data.frame!==undefined)frame=await this.renderer.capture(root,project,this.settings,Number(data.frame),data.signal instanceof AbortSignal?data.signal:undefined);
          return {ok:true,value:{projectId:project.id,revision:project.revision,spec,source,frame}};
        }
        case 'source':{const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');return {ok:true,value:await this.store.readSource(root,shot)};}
        case 'saveSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');const source=parseSceneSource(JSON.stringify(data.source));await this.store.writeSource(root,shot,source);project.revision++;await this.persist();await this.start('preview',async signal=>{const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));await this.store.markSourceGood(root,shot);},shot.id);break;}
        case 'restoreSource':{this.assertIdle();const {root,project}=this.required();const shot=project.shots.find(s=>s.id===data.shotId);if(!shot)throw new Error('镜头已不存在');await this.store.restoreSource(root,shot);project.revision++;await this.persist();break;}
        case 'preview':{const {root,project}=this.required();compileSpec(project);await this.refreshPreview();await this.start('preview',async signal=>{this.progress(.1,'检查资源与关键帧');const checked=await this.renderer.check(root,this.required().project,this.settings,signal);if(!checked.ok)throw new Error(checked.errors.map(e=>e.message).join('\n'));for(const shot of this.required().project.shots)await this.store.markSourceGood(root,shot);});break;}
        case 'generate':{
          const {root,project}=this.required(),route={provider:String(data.provider??''),model:String(data.model??'')},kind=data.kind as 'storyboard'|'scenes'|'modify';if(!['storyboard','scenes','modify'].includes(kind))throw new Error('生成类型无效');
          await this.start(kind,async signal=>{
            if(kind==='storyboard'){
              const shots=await this.generator().storyboard(structuredClone(project),route,signal);signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const current=this.required().project;
              current.shots=shots;current.shotOrder=shots.map(s=>s.id);delete current.extensions.graphEdges;current.revision++;
              for(let i=0;i<shots.length;i++){current.graph.positions[shots[i]!.id]=[420+i*340,160];await this.store.writeSource(root,shots[i]!,defaultSceneSource());}current.graph.positions['film-output']=[420+shots.length*340,160];await this.persist();});
            }else{
              compileSpec(this.required().project);const ids=data.shotId?[String(data.shotId)]:[...this.required().project.shotOrder];
              for(let i=0;i<ids.length;i++){signal.throwIfAborted();this.progress(i/ids.length,`生成镜头 ${i+1}/${ids.length}`);await this.generateScene(root,ids[i]!,route,signal,kind==='modify'?String(data.instruction??'改进画面与动作，保留内容'):undefined);}
            }
          },data.shotId);break;
        }
        case 'export':{const {root,project}=this.required();compileSpec(project);const snapshot=structuredClone(project);await this.start('export',async signal=>{const result=await this.renderer.export(root,snapshot,this.settings,signal,(p,m)=>this.progress(p,m));signal.throwIfAborted();await this.enqueue(async()=>{signal.throwIfAborted();const current=this.required().project;current.outputs.push(result);current.revision++;await this.persist();if(!result.url&&this.previewUrl)result.url=new URL(relative(root,result.path).split('/').map(encodeURIComponent).join('/'),this.previewUrl).href;});});break;}
        case 'cancel':this.controller?.abort(new Error('用户已取消'));break;
        case 'environment':this.assertIdle();for(const key of ['browserPath','ffmpegPath','ffprobePath'] as const)if(data[key]!==undefined){if(typeof data[key]!=='string')throw new Error('执行文件路径须为字符串');this.settings[key]=data[key];}await mkdir(this.baseDirectory,{recursive:true});await writeFile(join(this.baseDirectory,'environment.json'),JSON.stringify(this.settings,null,2));break;
        case 'reveal':{const {root}=this.required(),path=resolve(String(data.path??root));if(path!==root&&!path.startsWith(root+'/'))throw new Error('请选择本项目文件');if(!this.ctx.reveal)throw new Error('当前运行器没有文件打开服务');await this.ctx.reveal(path);break;}
        default:throw new Error('未找到应用操作');
      }
      return {ok:true,value:await this.snapshot()};
    }catch(error){return {ok:false,error:{code:error instanceof Error&&'code' in error?String(error.code):'STUDIO_ERROR',message:error instanceof Error?error.message:String(error)}};}
  }
  async dispose(){this.disposed=true;this.controller?.abort(new Error('应用已停止'));await this.commands;await this.job;await this.commands;await this.speech.close();await this.renderer.close();}
}
