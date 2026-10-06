import type { ModelRoute, SceneSource, StudioApi, StudioSnapshot, VideoProject } from '../shared/types.ts';

export interface ProjectHistory {canUndo:boolean;canRedo:boolean;entries:{id:string;label:string;createdAt:string;revision:number}[];cursor:number}
export interface StudioState {
  snapshot:StudioSnapshot|null;loading:boolean;pending:boolean;saving:boolean;dirty:boolean;sourceDraft:boolean;conflict:boolean;
  error:string;notice:string;scheme:'light'|'dark';selected:string|null;route:ModelRoute;
  canUndo:boolean;canRedo:boolean;history:ProjectHistory|null;localImages:Record<string,string>;focusFrame:number|null;focusSerial:number;
}
export interface YingliuBridge {
  call(endpoint:string,payload?:unknown):Promise<import('../shared/types.ts').RpcResult>;
  pickProject?():Promise<string|null>;
  pickExecutable?():Promise<string|null>;
  resetScene?():Promise<{reset:boolean}>;
  exportProject?(projectId:string):Promise<import('../shared/types.ts').RpcResult<{name:string;path?:string;dataBase64?:string;size:number}>|null>;
  importProject?():Promise<import('../shared/types.ts').RpcResult<StudioSnapshot>|null>;
  onBeforeClose?(handler:()=>Promise<{ok:boolean;message?:string}>):()=>void;
}
declare global {interface Window {yingliu?:YingliuBridge}}
export class StudioRequestError extends Error {constructor(message:string,readonly code:string){super(message);this.name='StudioRequestError';}}
export class StandaloneStudioApi implements StudioApi {
  async call<T>(endpoint:string,payload:unknown={}):Promise<T>{
    let response:import('../shared/types.ts').RpcResult;
    if(window.yingliu)response=await window.yingliu.call(endpoint,payload);
    else{
      const token=document.querySelector<HTMLMetaElement>('meta[name="yingliu-token"]')?.content;
      const http=await fetch(`/api/${encodeURIComponent(endpoint)}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Yingliu-Token':token}:{})},body:JSON.stringify(payload)});
      try{response=await http.json() as import('../shared/types.ts').RpcResult;}catch{throw new Error(`本地应用服务未返回有效数据（HTTP ${http.status}）。`);}
      if(!http.ok&&response.ok)throw new Error(`应用服务请求失败（HTTP ${http.status}）`);
    }
    if(!response||typeof response.ok!=='boolean')throw new Error('应用服务响应格式错误');
    if(!response.ok)throw new StudioRequestError(response.error.message,response.error.code);
    return response.value as T;
  }
}
/** One owner for edits, persisted history, revision checks, and project task polling. */
export class StudioController {
  private state:StudioState={snapshot:null,loading:true,pending:false,saving:false,dirty:false,sourceDraft:false,conflict:false,error:'',notice:'',scheme:'dark',selected:null,route:{provider:'',model:''},canUndo:false,canRedo:false,history:null,localImages:{},focusFrame:null,focusSerial:0};
  private listeners=new Set<()=>void>();private disposed=false;
  private saveTimer:ReturnType<typeof setTimeout>|undefined;private pollTimer:ReturnType<typeof setTimeout>|undefined;
  private sourceDraftDirty=false;
  private editSerial=0;private dirty=false;private savingPromise:Promise<void>|null=null;private saveFailed=false;
  private polling=false;private actionEpoch=0;private serverRevision:number|null=null;private serverProjectId:string|null=null;
  private creativeHandler:((kind:'storyboard'|'scenes'|'modify',instruction:string,shotId?:string)=>Promise<void>)|null=null;
  constructor(readonly api:StudioApi){}
  getSnapshot=():StudioState=>this.state;
  subscribe=(fn:()=>void):(()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(patch:Partial<StudioState>):void{if(this.disposed)return;this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private accept(snapshot:StudioSnapshot,protectDraft=true,ownSave=false):void{
    const previous=this.state.snapshot?.project||null;const same=previous?.id===snapshot.project?.id;
    const keepProject=protectDraft&&same&&this.dirty;const conflict=keepProject&&!ownSave&&snapshot.project?.revision!==this.serverRevision;
    if(!keepProject||ownSave){this.serverProjectId=snapshot.project?.id??null;this.serverRevision=snapshot.project?.revision??null;}
    const project=keepProject?previous:snapshot.project,changed=project?.id!==previous?.id;
    if(changed){this.dirty=false;this.update({history:null,canUndo:false,canRedo:false,localImages:{}});}
    const route=this.state.route;
    const available=snapshot.providers.filter(provider=>provider.id!=='demo');
    const provider=available.find(p=>p.id===route.provider)||available.find(p=>p.models.length);
    const model=provider?.models.find(m=>m.id===route.model)||provider?.models[0];
    const selected=this.state.selected;
    this.update({snapshot:{...snapshot,project},loading:false,dirty:this.dirty,
      ...(changed?{selected:null,focusFrame:null,conflict:false}:{}),...(conflict?{conflict:true,error:'工程已在其他操作中更新。本地修改已保留；请先导出本地副本，再重新载入已保存版本。'}:{}),
      ...(!selected||project?.shots.some(s=>s.id===selected)||project?.assets.some(a=>a.id===selected)?{}:{selected:null}),route:{provider:provider?.id||'',model:model?.id||''}});
    if(snapshot.task?.status==='running')this.schedulePoll();
  }
  async load(force=false):Promise<void>{try{const snapshot=await this.api.call<StudioSnapshot>('catalog');if(force){this.dirty=false;this.update({dirty:false,conflict:false,saving:false});}this.accept(snapshot,!force);if(!this.state.conflict)this.update({error:''});await this.refreshHistory();}catch(error){this.update({loading:false,error:message(error)});}}
  async refreshHistory():Promise<void>{
    const projectId=this.state.snapshot?.project?.id;if(!projectId)return;
    try{const history=await this.api.call<ProjectHistory>('history',{projectId});if(this.state.snapshot?.project?.id===projectId&&Array.isArray(history.entries))this.update({history,canUndo:history.canUndo,canRedo:history.canRedo});}catch{/* A history read never discards an unsaved draft. */}
  }
  async focusProject(project:string|{projectId?:string;path?:string;sessionId?:string;shotId?:string;frame?:number},focus:{shotId?:string;frame?:number;sessionId?:string}={}):Promise<void>{
    const payload=typeof project==='string'?{projectId:project,...focus}:project;await this.action('focus',payload);
    if(this.state.error)throw new Error(this.state.error);if(payload.projectId&&this.state.snapshot?.project?.id!==payload.projectId)throw new Error('工程定位未完成');
    const selected=payload.shotId??this.state.snapshot?.focus?.shotId;if(selected)this.select(selected);
    const frame=payload.frame??this.state.snapshot?.focus?.frame;if(frame!==undefined)this.update({focusFrame:frame,focusSerial:this.state.focusSerial+1});
  }
  async bindSession(sessionId:string):Promise<void>{await this.action('bindSession',{sessionId},'工程已关联到会话');}
  async audio(payload:unknown):Promise<void>{await this.action('audio',payload);}
  private schedulePoll():void{if(this.disposed||this.polling||this.pollTimer)return;this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.poll();},700);}
  private async poll():Promise<void>{
    if(this.disposed||this.polling)return;this.polling=true;const epoch=this.actionEpoch;
    try{const snapshot=await this.api.call<StudioSnapshot>('current',{projectId:this.state.snapshot?.project?.id});if(epoch===this.actionEpoch&&!this.state.pending){this.accept(snapshot);if(snapshot.task?.status!=='running')await this.refreshHistory();}}catch(error){this.update({error:message(error)});}
    finally{this.polling=false;if(this.state.snapshot?.task?.status==='running')this.schedulePoll();}
  }
  setScheme=(scheme:'light'|'dark'):void=>this.update({scheme});select=(selected:string|null):void=>{if(this.sourceDraftDirty&&selected!==this.state.selected){this.update({error:'前端源码尚未保存，请保存源码后再切换镜头。'});return;}this.update({selected});};
  setSourceDraftDirty(value:boolean):void{if(this.sourceDraftDirty===value)return;this.sourceDraftDirty=value;this.update({sourceDraft:value});}
  setRoute=(route:ModelRoute):void=>this.update({route});clearError=():void=>{if(!this.state.conflict)this.update({error:''});};notify=(notice:string):void=>this.update({notice});
  setCreativeHandler(handler:typeof this.creativeHandler):void{this.creativeHandler=handler;}
  edit=(project:VideoProject,_record=true):void=>{
    if(!this.state.snapshot||this.state.pending||this.state.conflict)return;
    const task=this.state.snapshot.task;if(task?.status==='running'&&['storyboard','scenes','modify','audio'].includes(task.kind))return;
    this.editSerial++;this.dirty=true;
    this.update({snapshot:{...this.state.snapshot,project},saving:true,dirty:true,notice:'',error:''});
    clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>{this.saveTimer=undefined;void this.flush();},450);
  };
  undo=():void=>{void this.action('undo',{},'已撤销上一步，历史保存在工程中。');};
  redo=():void=>{void this.action('redo',{},'已重做，历史保存在工程中。');};
  async flush():Promise<void>{
    clearTimeout(this.saveTimer);this.saveTimer=undefined;
    if(this.savingPromise){await this.savingPromise;if(this.dirty&&!this.saveFailed&&!this.state.conflict)return this.flush();return;}
    const project=this.state.snapshot?.project;if(!project||!this.dirty||this.state.conflict)return;
    const serial=this.editSerial;this.saveFailed=false;
    const operation=(async()=>{try{
      const expectedRevision=this.serverProjectId===project.id?this.serverRevision:undefined;
      const snapshot=await this.api.call<StudioSnapshot>('save',{project,expectedRevision});
      if(serial===this.editSerial){this.dirty=false;this.accept(snapshot,false,true);this.update({saving:false,dirty:false,error:'',conflict:false});}
      else{this.accept(snapshot,true,true);this.update({error:''});}
      await this.refreshHistory();
    }catch(error){this.saveFailed=true;const conflict=/revision|版本|冲突|修改.*更新|已更新/i.test(message(error))||(error instanceof StudioRequestError&&/CONFLICT/.test(error.code));this.update({saving:false,error:message(error),conflict});}})();
    this.savingPromise=operation;await operation;if(this.savingPromise===operation)this.savingPromise=null;
    if(this.dirty&&!this.saveFailed&&!this.state.conflict&&serial!==this.editSerial)await this.flush();
  }
  async action(endpoint:string,payload:unknown={},notice=''):Promise<void>{
    if(this.state.pending)return;this.actionEpoch++;this.update({pending:true,error:this.state.conflict?this.state.error:'',notice:''});
    try{
      await this.flush();if(this.sourceDraftDirty&&!['saveSource','restoreSource','reveal','environment','cancel'].includes(endpoint))throw new Error('前端源码尚未保存，请先在源码面板保存修改。');if(this.dirty)throw new Error(this.state.error||'项目尚未保存，请重试保存。');
      const guard=['saveSource','restoreSource','apply','rename','undo','redo','retry'].includes(endpoint)?{expectedRevision:this.serverRevision}:{};
      const request=['create','open','focus'].includes(endpoint)?payload:{projectId:this.state.snapshot?.project?.id,...guard,...payload as object};
      const snapshot=await this.api.call<StudioSnapshot>(endpoint,request);this.accept(snapshot,false);await this.refreshHistory();this.update({notice,conflict:false,error:''});
    }catch(error){this.update({error:message(error)});}finally{this.update({pending:false});}
  }
  async generate(kind:'storyboard'|'scenes'|'modify',instruction='',shotId?:string):Promise<void>{
    if(this.busy)return;if(this.creativeHandler)return this.creativeHandler(kind,instruction,shotId);
    if(!this.state.route.provider||!this.state.route.model){this.update({error:'请在模型设置中配置创作模型。'});return;}await this.action('generate',{kind,instruction,shotId,...this.state.route});
  }
  async readSource(shotId:string):Promise<SceneSource>{return this.api.call<SceneSource>('source',{shotId,projectId:this.state.snapshot?.project?.id});}
  async saveSource(shotId:string,source:SceneSource):Promise<void>{await this.action('saveSource',{shotId,source},'源码已保存，可以刷新预览。');if(!this.state.error)this.setSourceDraftDirty(false);}
  async restoreSource(shotId:string):Promise<void>{await this.action('restoreSource',{shotId},'已恢复上次可用源码。');}
  async importFile(file:File):Promise<void>{
    if(file.type.startsWith('image/')){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});const asset=[...(this.state.snapshot?.project?.assets||[])].reverse().find(a=>a.name===file.name&&a.kind==='image');if(asset)this.update({localImages:{...this.state.localImages,[asset.id]:data}});}
    else if(file.type.startsWith('text/')||/\.(txt|md)$/i.test(file.name))await this.action('import',{name:file.name,mime:'text/plain',text:await file.text()});
    else if(file.type.startsWith('audio/')||/\.(wav|mp3|m4a|aac|flac|ogg|aiff)$/i.test(file.name)){const data=await readDataUrl(file);await this.action('import',{name:file.name,mime:file.type,dataBase64:data.slice(data.indexOf(',')+1)});}
    else this.update({error:'请选择图片、文字或 WAV、MP3、M4A、AAC、FLAC、OGG 音频。'});
  }
  get busy():boolean{return this.state.pending||this.state.snapshot?.task?.status==='running';}
  get hasSourceDraft():boolean{return this.sourceDraftDirty;}
  get hasUnsavedChanges():boolean{return this.dirty||this.sourceDraftDirty;}
  async dispose():Promise<void>{clearTimeout(this.saveTimer);clearTimeout(this.pollTimer);await this.flush();this.disposed=true;this.listeners.clear();}
}
function message(error:unknown):string{return error instanceof Error?error.message:'操作未完成';}
function readDataUrl(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('读取素材失败'));reader.readAsDataURL(file);});}
