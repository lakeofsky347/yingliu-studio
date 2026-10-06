import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileSpec } from '../core/index.ts';
import { normalizeStoryboard, parseModelJson, parseSceneSource } from '../host/generator.ts';
import type { Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { BackendPort, ChatInput, ChatMessage, Conversation } from './contracts.ts';
import { DEMO_MODEL, DEMO_PROVIDER, demoSceneSource, demoStoryboard, ProviderManager } from './model.ts';
import { directorPackContext } from './packs.ts';

type ObjectValue=Record<string,unknown>;
function object(value:unknown):ObjectValue{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};}
function message(role:ChatMessage['role'],content:string,actions?:ChatMessage['actions']):ChatMessage{return {id:randomUUID(),role,content,createdAt:new Date().toISOString(),...(actions?{actions}:{})};}
function abortableDelay(signal:AbortSignal){return new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},80);signal.addEventListener('abort',abort,{once:true});});}
function shortTopic(text:string):string{let topic=text.trim();for(let i=0;i<8;i++){const next=topic.replace(/^(?:请帮我|请为我|帮我|给我|我想|做一个|做一段|做个|先生成|先做|制作|创建|生成|新建|一个|一段|视频|关于|介绍|为我|请)[\s，,：:]*/,'');if(next===topic)break;topic=next;}return topic.replace(/(?:的)?(?:视频|短片|初稿)[。！!]*$/,'').trim().slice(0,100)||text.slice(0,80);}

export function selectedShots(project:VideoProject,input:Pick<ChatInput,'message'|'shotId'>):Shot[]{
  if(/(?:全部|所有|全片|每个)\s*(?:镜头|分镜)?/.test(input.message))return project.shotOrder.map(id=>project.shots.find(s=>s.id===id)!).filter(Boolean);
  const ordinal=input.message.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:个)?\s*(?:镜头|分镜|镜)/);
  if(ordinal){const values:Record<string,number>={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};const index=/^\d+$/.test(ordinal[1]!)?Number(ordinal[1]):values[ordinal[1]!];const shot=project.shots.find(s=>s.id===project.shotOrder[(index??0)-1]);if(!shot)throw new Error('指定镜头不存在，请确认当前分镜顺序');return [shot];}
  if(input.shotId){const shot=project.shots.find(s=>s.id===input.shotId);if(!shot)throw new Error('选中的镜头已不存在');return [shot];}
  const byId=project.shots.find(s=>input.message.includes(s.id));if(byId)return [byId];
  const byTitle=project.shots.filter(s=>s.title.length>1&&input.message.includes(s.title));if(byTitle.length===1)return byTitle;
  const first=project.shots.find(s=>s.id===project.shotOrder[0]);return first?[first]:[];
}
export function demoPatch(shot:Shot,text:string,fps:number):Partial<Shot>{
  const patch:Partial<Shot>={},params={...shot.params};let changed=false;
  const colors:Record<string,string>={黑色:'#101010',白色:'#ffffff',蓝色:'#183c66',红色:'#7a2633',绿色:'#163f35',紫色:'#382554',橙色:'#754323',黄色:'#6e5b20',深蓝:'#101c36',深绿:'#102b23'};
  const explicit=text.match(/#[a-fA-F0-9]{6}\b/),name=Object.keys(colors).find(color=>text.includes(color));
  if(explicit||name){const color=explicit?.[0]??colors[name!]!;if(/(?:强调|点缀|accent)/i.test(text))params.accent=color;else if(/(?:字体|文字).*颜色|文字.*(?:蓝|红|绿|白|黑|紫)/.test(text))params.foreground=color;else params.background=color;changed=true;}
  const motion:Shot['params']['motion']|undefined=/缩放|推近|zoom/i.test(text)?'zoom':/滑动|滑入|slide/i.test(text)?'slide':/淡入|淡出|fade/i.test(text)?'fade':/无动画|静止|取消动画|none/i.test(text)?'none':undefined;
  if(motion){params.motion=motion;changed=true;}
  const duration=text.match(/(?:时长|持续|停留|延长|缩短|改为|改成|设为|设成)?\s*(\d+(?:\.\d+)?)\s*秒/);
  if(duration){const seconds=Number(duration[1]);if(seconds<=0||seconds>3600)throw new Error('镜头时长须在 0–3600 秒之间');patch.durationFrames=Math.max(1,Math.round(seconds*fps));}
  const title=text.match(/(?:标题|镜头名称|分镜名称)\s*(?:改为|改成|设为|设成|换成|[:：])\s*[“「"']?([^”」"'，,。；;\n]+)/);
  if(title){patch.title=title[1]!.trim();params.text=patch.title;changed=true;}
  const display=text.match(/(?:屏幕文字|主文字|文案|字幕)\s*(?:改为|改成|设为|设成|换成|[:：])\s*[“「"']?([^”」"'，,。；;\n]+)/);
  if(display){if(/字幕/.test(display[0]))params.subtitle=display[1]!.trim();else params.text=display[1]!.trim();changed=true;}
  if(changed)patch.params=params;return patch;
}

const DIRECTOR=`你是映流视频工作台的对话导演。必须输出一个完整 JSON 对象，不能带 Markdown。你在同一多轮对话中创作、读取工具回执、修正结果。只使用当前工程和已有素材，不能编造事实、素材文件或声称看过图片。当前路径只传入文本、图片元信息和关键帧诊断元数据，没有把 PNG 像素发给你。禁止声称已视觉检查。源码只在受限浏览器运行、不能联网或安装依赖。代码必须按 frame/localFrame/time 确定画面，读取 ctx.params，支持任意帧和倒序；html静态布局，css局部类，js导出 render(ctx)，可导出 async ready(ctx)。ctx含 root,canvas,ctx2d,params,assets,localFrame,progress,time,duration,width,height。
输出格式：{"message":"简明说明","done":true,"actions":[{"tool":"video_update","arguments":{"expectedRevision":当前版本,"update":{"shotPatches":[{"id":"已有镜头ID","patch":{"params":{"motion":"fade"}}}],"sources":[{"shotId":"已有镜头ID","source":{"html":"...","css":"...","js":"export function render(ctx) {...}"}}]}}}]}。
首次创作可在 video_update.update 使用 storyboard:{shots:[{title,intent,composition,action,durationSeconds,assetIds,referenceIds,transition,params}]} 和 sourcesByIndex:[{html,css,js}]（3–5镜，每镜对应源码）；应用会分配稳定ID。已有工程只局部修改 allowedShotIds，保留ID、sourcePath和未要求改动的手动标题，不用全量shots覆盖。params只填要改变的字段。
允许五类工具语义：video_project（仅get当前工程）、video_update、video_inspect（frame或shotId及includeSource）、video_render（action=preview/check）、video_audio（导入/绑定/更新/删除；不自动远程合成）。默认生成完成后应用会预览并读取关键帧元数据。可设置done:false请求再读工具结果，但整个任务最多3轮。所有动作严格围绕当前用户请求，不操作其它工程，不写任意路径。`;

/** A persisted app conversation owns the director loop; graph edits are read before every turn. */
export class ConversationService {
  private controller?:AbortController;private activeProjectId?:string;private ownedTaskId?:string;
  constructor(private backend:BackendPort,private providers:ProviderManager,private dataDirectory:string){}
  private filename(projectId?:string){return join(this.dataDirectory,'conversations',createHash('sha256').update(projectId??'unbound').digest('hex')+'.json');}
  async history(projectId?:string):Promise<Conversation>{
    try{const value=object(JSON.parse(await readFile(this.filename(projectId),'utf8')));if(typeof value.id!=='string'||!Array.isArray(value.messages)||value.projectId!==projectId)throw new Error('对话文件格式无效');return value as unknown as Conversation;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {id:randomUUID(),...(projectId?{projectId}:{}),messages:[],provider:DEMO_PROVIDER,model:DEMO_MODEL};}
  }
  private async persist(conversation:Conversation){await mkdir(join(this.dataDirectory,'conversations'),{recursive:true});const path=this.filename(conversation.projectId);await writeFile(path+'.tmp',JSON.stringify(conversation,null,2)+'\n');await rename(path+'.tmp',path);}
  cancel():void{this.controller?.abort(new Error('用户已取消对话制作'));const projectId=this.activeProjectId,taskId=this.ownedTaskId;
    if(projectId&&taskId)void this.backend.call<StudioSnapshot>('current',{projectId}).then(snapshot=>{if(snapshot.task?.id===taskId&&snapshot.task.status==='running')return this.backend.call('cancel',{projectId});}).catch(()=>{});
  }
  private async settle(snapshot:StudioSnapshot,signal:AbortSignal):Promise<StudioSnapshot>{
    const taskId=snapshot.task?.id;while(snapshot.task?.status==='running'){await abortableDelay(signal);snapshot=await this.backend.call('current',{projectId:snapshot.project!.id});if(taskId&&snapshot.task?.id!==taskId)throw new Error('制作任务已被另一任务替换');}
    signal.throwIfAborted();if(snapshot.task?.status==='failed'||snapshot.task?.status==='cancelled')throw new Error(snapshot.task.error??snapshot.task.message);return snapshot;
  }
  private async apply(project:VideoProject,update:ObjectValue,signal:AbortSignal):Promise<StudioSnapshot>{signal.throwIfAborted();return this.backend.call('apply',{projectId:project.id,expectedRevision:project.revision,...update});}
  private async preview(snapshot:StudioSnapshot,signal:AbortSignal):Promise<StudioSnapshot>{signal.throwIfAborted();const started=await this.backend.call<StudioSnapshot>('preview',{projectId:snapshot.project!.id});this.ownedTaskId=started.task?.id;return this.settle(started,signal);}
  async send(input:ChatInput):Promise<{conversation:Conversation;snapshot:StudioSnapshot}>{
    if(this.controller)throw new Error('已有对话制作进行中，请等待或取消');if(!input.message.trim())throw new Error('请填写制作请求');if(input.message.length>20000)throw new Error('单次请求超过 20,000 字符，请缩小修改范围');
    const controller=new AbortController();this.controller=controller;const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(240000)]);let conversation:Conversation;
    try{conversation=await this.history(input.projectId);conversation.provider=input.provider;conversation.model=input.model;conversation.messages.push(message('user',input.message));await this.persist(conversation);}
    catch(error){this.controller=undefined;throw error;}
    try{
      signal.throwIfAborted();const createNew=/^(?:请\s*)?(?:新建|创建新的|新做|重新做)(?:一个|一段|视频|工程|项目)?/.test(input.message);
      let snapshot=await this.backend.call<StudioSnapshot>('current',input.projectId?{projectId:input.projectId}:{});const shouldCreate=!snapshot.project||createNew;const fresh=shouldCreate||snapshot.project?.shots.length===0;
      if(shouldCreate){const topic=shortTopic(input.message);const requestedDuration=input.message.match(/(\d+(?:\.\d+)?)\s*秒/);const targetDuration=requestedDuration?Number(requestedDuration[1]):18;if(targetDuration<=0||targetDuration>3600)throw new Error('初稿时长须在 0–3600 秒之间');snapshot=await this.backend.call('create',{title:topic.slice(0,36),topic,targetDuration});}
      else if(fresh){snapshot=await this.apply(snapshot.project!,{topic:shortTopic(input.message),title:snapshot.project!.title==='未命名影片'?shortTopic(input.message).slice(0,36):snapshot.project!.title},signal);}
      if(!snapshot.project)throw new Error('视频工程创建失败');this.activeProjectId=snapshot.project.id;
      if(conversation.projectId!==snapshot.project.id){conversation=await this.history(snapshot.project.id);conversation.provider=input.provider;conversation.model=input.model;conversation.messages.push(message('user',input.message));}
      conversation.projectId=snapshot.project.id;await this.persist(conversation);
      let reply:string;
      if(input.provider===DEMO_PROVIDER){
        if(input.model!==DEMO_MODEL)throw new Error('离线演示模型已改变，请重新选择');
        if(fresh||snapshot.project.shots.length===0){const shots=demoStoryboard(snapshot.project);snapshot=await this.apply(snapshot.project,{shots,sources:shots.map((shot,index)=>({shotId:shot.id,source:demoSceneSource(index)})),extensions:{yingliuDemo:{kind:'deterministic-fixture',realModel:'NOT_CHECKED'}}},signal);
          reply='已用离线演示模型生成 3 个可编辑镜头和实际场景代码。这是确定性演示提纲，主题、配色和文字来自本次请求，真实模型创作尚未检查。';
        }else{const selected=selectedShots(snapshot.project,input);const patches=selected.map(shot=>({id:shot.id,patch:demoPatch(shot,input.message,snapshot.project!.target.fps.num/snapshot.project!.target.fps.den)})).filter(item=>Object.keys(item.patch).length);
          if(patches.length){snapshot=await this.apply(snapshot.project,{shotPatches:patches},signal);reply=`已修改 ${patches.length} 个镜头，保留稳定镜头 ID 和未要求改动的手动标题。离线演示支持颜色、运动、时长、标题和屏幕文字。`;}
          else reply='当前为离线演示。工程已读取；可输入“第二镜背景改成蓝色”“选中镜头滑入，时长 8 秒”或“第三镜标题改为下一步”。这条请求未改变工程。';
        }
      }else if(input.provider==='custom'){
        const settings=await this.providers.settings();if(input.model!==settings.config.model)throw new Error('模型配置已改变，请重新选择模型');
        const result=await this.direct(conversation,snapshot,input,fresh,signal);snapshot=result.snapshot;reply=result.message;
      }else throw new Error('未知模型供应商');
      snapshot=await this.preview(snapshot,signal);const project=snapshot.project!,spec=compileSpec(project);
      const frame=Math.min(spec.durationFrames-1,Math.floor(spec.durationFrames/2));signal.throwIfAborted();
      // inspect without frame pixels is deliberately metadata-only in the acceptance statement.
      const inspection=await this.backend.call<ObjectValue>('inspect',{projectId:project.id,shotId:spec.shots.find(s=>frame>=s.startFrame&&frame<s.endFrame)?.id,includeSource:false});
      if(inspection.revision!==undefined&&inspection.revision!==project.revision)throw new Error('检查期间工程已修改，请重新预览');
      reply+=' 已生成初稿预览并完成代码/关键帧运行检查；此回执不代表模型视觉检查或人工观看。';
      conversation.messages.push(message('assistant',reply,[{label:'打开初稿',projectId:project.id,revision:project.revision,frame:0}]));await this.persist(conversation);return {conversation:structuredClone(conversation),snapshot};
    }catch(error){const failure=signal.aborted?(signal.reason instanceof Error?signal.reason:new Error('对话制作已取消')):error;conversation.messages.push(message('assistant',`制作未完成：${failure instanceof Error?failure.message:String(failure)}`));await this.persist(conversation);throw failure;}
    finally{this.controller=undefined;this.activeProjectId=undefined;this.ownedTaskId=undefined;}
  }
  private async direct(conversation:Conversation,snapshot:StudioSnapshot,input:ChatInput,fresh:boolean,signal:AbortSignal):Promise<{snapshot:StudioSnapshot;message:string}>{
    const allowedIds=selectedShots(snapshot.project!,input).map(s=>s.id);let reply='',mutated=false;
    const turns=conversation.messages.slice(-16).map(m=>({role:m.role,content:m.content}));
    for(let round=0;round<3;round++){
      signal.throwIfAborted();const project=snapshot.project!,context={task:fresh&&!mutated?'create-film':'modify-film',request:input.message,project,allowedShotIds:fresh?project.shotOrder:allowedIds,inspectionMode:'metadata-only; no image pixels supplied'};
      turns.push({role:'user',content:'当前制作上下文：'+JSON.stringify(context)});const raw=await this.providers.complete(turns,DIRECTOR+'\n'+directorPackContext,signal,7000);turns.push({role:'assistant',content:raw});
      let plan:ObjectValue;
      try{plan=parseModelJson(raw);}catch(error){if(round===2)throw error;turns.push({role:'user',content:'上次 JSON 无法读取，请修复为规定的完整 JSON；尚未提交工程。'});continue;}
      if(typeof plan.message==='string')reply=/(?:看过|查看|检查|分析|识别).*(?:图像|图片|截图|PNG)|视觉/.test(plan.message)?'已提交导演计划；当前只使用工程、素材描述和运行诊断元数据，未将图片像素发送给模型。':plan.message;
      if(!Array.isArray(plan.actions)||plan.actions.length>8)throw new Error('导演计划需要最多 8 个动作');
      const receipts:ObjectValue[]=[];
      for(const action of plan.actions){signal.throwIfAborted();const item=object(action),args=object(item.arguments),tool=String(item.tool??'');
        if(args.projectId!==undefined&&args.projectId!==project.id)throw new Error('导演计划不能操作其它工程');
        if(tool==='video_project'){if(args.action&&args.action!=='get')throw new Error('对话内只允许查看当前工程');snapshot=await this.backend.call('current',{projectId:project.id});receipts.push({tool,project:snapshot.project});}
        else if(tool==='video_update'){
          if(args.expectedRevision!==snapshot.project!.revision)throw new Error('导演计划基于旧版本，请重新发送请求');
          const update=object(args.update),next:ObjectValue={};
          if(fresh&&!mutated&&update.storyboard){const data=object(update.storyboard);if(!Array.isArray(data.shots)||data.shots.length<3||data.shots.length>5)throw new Error('初稿需要 3–5 个镜头');const shots=normalizeStoryboard(data,snapshot.project!);
            if(!Array.isArray(update.sourcesByIndex)||update.sourcesByIndex.length!==shots.length)throw new Error('初稿每个镜头都需要场景源码');
            const sources=update.sourcesByIndex;next.shots=shots;next.sources=shots.map((shot,index)=>({shotId:shot.id,source:parseSceneSource(JSON.stringify(sources[index]))}));
          }else{
            if(update.shots||update.storyboard||update.shotOrder)throw new Error('已有工程请提交指定镜头的局部补丁');
            const patches=Array.isArray(update.shotPatches)?update.shotPatches:[];next.shotPatches=patches.map(item=>{const entry=object(item),id=String(entry.id??entry.shotId??'');if(!allowedIds.includes(id)&&!fresh)throw new Error('导演计划修改了未选中的镜头');
              const shot=snapshot.project!.shots.find(s=>s.id===id);if(!shot)throw new Error('导演计划引用了不存在的镜头');const patch=object(entry.patch);delete patch.id;delete patch.sourcePath;
              if(!/(?:标题|名称).*(?:改|设|换)|(?:改|设|换).*(?:标题|名称)/.test(input.message))delete patch.title;
              if(patch.params)patch.params={...shot.params,...object(patch.params)};return {id,patch};});
            next.sources=(Array.isArray(update.sources)?update.sources:[]).map(value=>{const entry=object(value),id=String(entry.shotId??'');if(!allowedIds.includes(id)&&!fresh)throw new Error('导演计划修改了未选中的镜头源码');return {shotId:id,source:parseSceneSource(JSON.stringify(entry.source))};});
          }
          snapshot=await this.apply(snapshot.project!,next,signal);mutated=true;receipts.push({tool,revision:snapshot.project!.revision,shots:snapshot.project!.shots});
        }else if(tool==='video_inspect'){receipts.push({tool,inspection:await this.backend.call('inspect',{projectId:project.id,shotId:args.shotId,includeSource:args.includeSource===true})});}
        else if(tool==='video_render'){if(!['preview','check'].includes(String(args.action)))throw new Error('对话导演只允许预览/检查，MP4 导出请使用界面按钮');snapshot=await this.preview(snapshot,signal);receipts.push({tool,revision:snapshot.project!.revision,task:snapshot.task});}
        else if(tool==='video_audio'){if(!['add','update','remove'].includes(String(args.action)))throw new Error('对话音频工具只允许编辑已导入音轨，请先从界面导入素材');snapshot=await this.backend.call('audio',{...object(args.request),projectId:project.id,action:args.action});receipts.push({tool,revision:snapshot.project!.revision});}
        else throw new Error('导演计划包含不支持的工具');
      }
      if(plan.done===true){if(fresh&&!mutated)throw new Error('模型没有生成初稿镜头与源码');return {snapshot,message:reply||'已提交导演计划并保留工程可编辑性。'};}
      turns.push({role:'user',content:'实际工具回执（只有元数据，未发送 PNG）：'+JSON.stringify(receipts)});
    }
    throw new Error('导演计划超过 3 轮上限，请缩小修改范围后重试');
  }
}
