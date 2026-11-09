import { imageMetadata } from '../models/image-input.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { addShot, bindAsset, compileSpec, createProject, deleteShot, reorderShots, unbindAsset, updateShot, updateTarget, validateProject } from '../core/index.ts';
import { normalizeStoryboard, parseModelJson, parseSceneSource } from '../host/generator.ts';
import { projectPath } from '../host/store.ts';
import type { AudioClip, SceneSource, Shot, StudioSnapshot, VideoProject } from '../shared/types.ts';
import type { BackendPort, ChatInput, ChatMessage, Conversation, ConversationTurn, ProviderConfig, ConversationServiceOptions } from './contracts.ts';
import { DEMO_MODEL, DEMO_PROVIDER, demoSceneSource, demoStoryboard, ProviderManager, type ModelContent, type ModelMessage } from './model.ts';
import { packBriefContext } from './packs.ts';
import type { AgentTaskStatus, ValidationReceipt, AgentCandidatePayload } from '../agent/contracts.ts';
import { contentHash } from '../agent/repository.ts';

type Obj=Record<string,unknown>;
type Intent='chat'|'discuss'|'create'|'modify';
function object(value:unknown):Obj{if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('导演参数必须是对象');return value as Obj;}
function array(value:unknown,label:string):unknown[]{if(!Array.isArray(value))throw new Error(label+' 须为数组');return value;}
function text(value:unknown,label:string):string{if(typeof value!=='string')throw new Error(label+' 须为字符串');return value;}
function message(role:ChatMessage['role'],content:string,turnId:string,status:ChatMessage['status'],actions?:ChatMessage['actions']):ChatMessage{return {id:randomUUID(),role,content,turnId,status,createdAt:new Date().toISOString(),...(actions?{actions}:{})};}
function errorText(error:unknown){return error instanceof Error?error.message:String(error);}
function shortTopic(value:string):string{let topic=value.trim();for(let i=0;i<8;i++){const next=topic.replace(/^(?:请帮我|请为我|帮我|给我|我想|做一个|做一段|做个|先生成|先做|制作|创建|生成|新建|一个|一段|视频|关于|介绍|为我|请)[\s，,：:]*/,'');if(next===topic)break;topic=next;}return topic.replace(/(?:的)?(?:视频|短片|初稿)[。！!]*$/,'').trim().slice(0,100)||value.slice(0,80);}
export function inferIntent(input:ChatInput,hasProject:boolean):Intent|'auto'{
  if(input.intent&&input.intent!=='auto')return input.intent;
  if(/^(?:你好|您好|hi\b|hello\b|谢谢|感谢|早上好|晚安|你是谁|你能做什么)/i.test(input.message.trim()))return 'chat';
  if(/先(?:聊|讨论)|只(?:讨论|聊)|(?:怎么|如何|能否|可以吗|建议|方案|思路|如果)/.test(input.message)&&!/(?:直接|开始|请|帮我).*(?:生成|制作|创建|修改)/.test(input.message))return 'discuss';
  if(/(?:新建|创建|新做|制作|生成|做一个|做一段|做个).*(?:视频|短片|影片|初稿|工程)|^(?:新建|重新做)/.test(input.message))return hasProject&&!/新|重新|另一个/.test(input.message)?'modify':'create';
  if(hasProject&&/改|增加|添加|删|移除|重排|换|绑定|调整|延长|缩短|镜头|分镜/.test(input.message))return 'modify';
  return 'auto';
}
export function selectedShots(project:VideoProject,input:Pick<ChatInput,'message'|'shotId'>):Shot[]{
  if(/(?:全部|所有|全片|每个)\s*(?:镜头|分镜)?/.test(input.message))return project.shotOrder.map(id=>project.shots.find(s=>s.id===id)!).filter(Boolean);
  const match=input.message.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:个)?\s*(?:镜头|分镜|镜)/);
  if(match){const ordinals:Record<string,number>={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12};const index=/^\d+$/.test(match[1]!)?Number(match[1]):ordinals[match[1]!];const shot=project.shots.find(s=>s.id===project.shotOrder[(index??0)-1]);if(!shot)throw new Error('指定镜头不存在，请确认当前分镜顺序');return [shot];}
  if(input.shotId){const shot=project.shots.find(s=>s.id===input.shotId);if(!shot)throw new Error('选中镜头已不存在');return [shot];}
  const named=project.shots.filter(s=>input.message.includes(s.id)||s.title.length>1&&input.message.includes(s.title));return named.length===1?named:[];
}

const DIRECTOR=`你是映流 Studio 的对话导演。通过同一个多轮 messages 回答、讨论方案或编辑工程。输出完整 JSON 对象：{"intent":"chat|discuss|create|modify","message":"给用户的自然回答","done":true,"actions":[]}。闲聊或讨论只回答，不创建、不改工程、不预览；用户明确要求创作/修改时才提交动作。不要为了闲聊生成空工程。创作镜头数量按内容需要为1–12，不机械固定数量。
工具计划每轮最多16动作、最多4轮；这是先规划后事务提交的协议，不是直接shell调用。done:false可先索取读取结果；全部修改动作在done:true时统一校验并一次提交。任何无效动作都使整个计划不提交。可以修复格式或工具规划错误，但工程版本冲突必须读新版本合并，不能覆盖用户修改。
工具：
video_project action=get读取当前工程；action=create提供title/topic/targetDuration/target，仅用户明确新建时使用。
video_update arguments={expectedRevision,update:{title?,topic?,targetDuration?,target?,storyboard?:{shots:[...]},sourcesByIndex?:[source],addShots?:[{tempId,afterId?,title,intent,composition,action,durationSeconds,assetIds,referenceIds,transition,params,source}],deleteShotIds?:[ID],shotOrder?:[ID或tempId],shotPatches?:[{id,patch:{title?,intent?,composition?,action?,narration?,durationFrames?,durationSeconds?,transition?,assetIds?,referenceIds?,params?}}],assetBindings?:[{shotId,assetId,kind:"asset|reference",remove?:true}],sources?:[{shotId,source}],audioClips?:[...]}}。已有工程不要使用storyboard或全量shots覆盖；稳定ID/sourcePath由应用控制。删除、重排、添加要符合用户明确请求。初次storyboard每镜用title,intent,composition,action,durationSeconds,assetIds,referenceIds,transition,params；sourcesByIndex每镜一份真实源码。新增镜必须给source。
若工程 videoClips 中有绑定该镜头的片段，宿主已按当前帧绘制视频底图。ctx.hasVideo 表示底图存在，ctx.video 给出 assetId/sourceFrame/time。场景源码仅叠加文字或图形，不用不透明全屏背景遮挡底图，不自行启动 video 播放或累计时间。
video_inspect arguments={shotId?,includeSource?:true}读取当前已有源码/规范；当前不会返回截图像素。video_render action=preview/check要求实际运行检查；创作/源码修改必须先验证候选再提交。video_audio 仅调整已导入音轨的add/update/remove，不导入任意路径、不远程合成。
参数只填写要改的字段，保留用户未要求修改的标题、时长、文字、布局和主链。用户选中镜头或明确第二/第三镜时只改对应ID；用户明确全片、删除或重排时可处理需要的范围。素材仅引用项目已有ID，不能编造路径或素材；图片若未明确启用发送，仅元信息进入上下文。
源码为 {html,css,js}，JS ES模块导出render(ctx)，可导出async ready(ctx)。ctx含root,canvas,ctx2d,params,assets,frame,localFrame,progress,time,duration,width,height。按帧独立求值支持重复/倒序，用ctx.params保持可编辑，不使用墙钟/autoplay，不联网、不导入包、不读写文件。所有文字和图像加载都要符合实际资源就绪。
内置协作工具：agent_delegate arguments={goal,role:"scene|vision|director",shotIds:[授权镜头ID],mode:"team|subagent"}委派独立子会话；agent_wait arguments={taskId}等待；agent_result arguments={taskId}取真实结果；agent_cancel arguments={taskId}停止本轮子任务；agent_accept arguments={candidateId}采用已经验收的成员候选，完整源码由宿主合并，不要转抄进上下文。不要编造任务ID；委派/读取与工程写动作分轮执行。子代理结果是候选，只有当前主会话可采用。done:true仅申请完成，修改请求必须有可验证的实际修改；无法完成时明确说明阻碍。
只陈述已发生的检查。素材像素是否发送以imageEvidence为准；未发送不能称看过图像。读取规范、运行检查、视觉观察、人工观看是不同回执。内置配方是可选简报参考，不代表现成风格渲染器已实现。`;

interface PreparedPlan {intent:Intent;reply:string;candidate:VideoProject|null;sources:{shotId:string;source:SceneSource}[];mutated:boolean;create:boolean;preview:boolean;inspect:Obj[]}
function scene(value:unknown):SceneSource{const source=parseSceneSource(JSON.stringify(value));if(source.html.length+source.css.length+source.js.length>2_000_000)throw new Error('单镜头源码超过2MB');return {html:source.html,css:source.css,js:source.js};}
function checkAssets(items:unknown[],project:VideoProject):void{const known=new Set(project.assets.map(asset=>asset.id));for(const raw of items){const item=object(raw);for(const field of ['assetIds','referenceIds'])if(item[field]!==undefined)for(const id of array(item[field],field))if(typeof id!=='string'||!known.has(id))throw new Error('分镜引用了不存在的素材：'+String(id));}}
function allowStructural(input:ChatInput,intent:Intent){return intent==='create'||/(?:添加|增加|插入|新增|删除|移除|重排|顺序|交换|镜头.*(?:前|后)|(?:前|后).*镜头|重新安排|重做)/.test(input.message);}

/** Compile every mutation locally before making any backend write. */
export function compileDirectorPlan(plan:Obj,snapshot:StudioSnapshot,input:ChatInput,requested:Intent|'auto'):PreparedPlan{
  const rawIntent=plan.intent??(requested==='auto'?(snapshot.project?'modify':'create'):requested);
  if(!['chat','discuss','create','modify'].includes(String(rawIntent)))throw new Error('导演计划的intent无效');
  const intent=rawIntent as Intent;if(requested==='chat'||requested==='discuss'){if(intent!==requested&&intent!=='chat'&&intent!=='discuss')throw new Error('本轮仅聊天/讨论，不能编辑工程');}
  if(requested==='modify'&&intent==='create')throw new Error('用户本轮要求修改当前工程，不能创建另一个工程');
  const actions=array(plan.actions??[],'actions');if(actions.length>16)throw new Error('导演计划超过16个动作');
  let candidate=snapshot.project?structuredClone(snapshot.project):null,creating=false,mutated=false,preview=false;const sourceMap=new Map<string,SceneSource>(),aliases=new Map<string,string>(),inspect:Obj[]=[];
  const resolveId=(id:unknown)=>aliases.get(String(id))??String(id);
  const ensure=()=>{if(!candidate){if(intent!=='create')throw new Error('还没有工程；请先明确创建视频');candidate=createProject(shortTopic(input.message),shortTopic(input.message));candidate.shots=[];candidate.shotOrder=[];candidate.graph={positions:{},groups:[]};const seconds=input.message.match(/(\d+(?:\.\d+)?)\s*秒/);candidate.targetDuration=seconds?Number(seconds[1]):30;creating=true;}return candidate;};
  const selected=snapshot.project?selectedShots(snapshot.project,input).map(s=>s.id):[];
  const checkScope=(id:string)=>{if(selected.length&&!creating&&!allowStructural(input,intent)&&!selected.includes(id))throw new Error('导演计划修改了未选中的镜头');};
  for(const raw of actions){const action=object(raw),args=object(action.arguments??{}),tool=String(action.tool??'');
    if(args.projectId!==undefined&&args.projectId!==snapshot.project?.id)throw new Error('不能操作本轮以外的工程');
    if(tool==='video_project'){
      if(args.action===undefined||args.action==='get'){inspect.push({kind:'project'});continue;}
      if(args.action!=='create'||intent!=='create'||snapshot.project&&!/新|另一个|重新|创建/.test(input.message)&&input.intent!=='create')throw new Error('本轮未授权创建其它工程');
      if(mutated)throw new Error('create须在修改动作之前');candidate=null;creating=false;const project=ensure();for(const key of ['title','topic']as const)if(args[key]!==undefined)project[key]=text(args[key],key);if(args.targetDuration!==undefined)project.targetDuration=Number(args.targetDuration);if(args.target)candidate=updateTarget(project,object(args.target));mutated=true;
    }else if(tool==='video_update'){
      if(intent==='chat'||intent==='discuss')throw new Error('聊天/讨论不能修改视频');let project=ensure();const expected=creating?0:snapshot.project!.revision;
      if(args.expectedRevision!==expected)throw new Error(`版本冲突：计划期望${args.expectedRevision}，当前${expected}；请按回执更新`);
      const update=object(args.update);for(const key of Object.keys(update))if(!['title','topic','targetDuration','target','storyboard','sourcesByIndex','addShots','deleteShotIds','shotOrder','shotPatches','assetBindings','sources','audioClips','selectedShotId'].includes(key))throw new Error('不支持的工程字段：'+key);
      for(const key of ['title','topic']as const)if(update[key]!==undefined)project[key]=text(update[key],key);
      if(update.targetDuration!==undefined)project.targetDuration=Number(update.targetDuration);if(update.target)project=updateTarget(project,object(update.target));
      if(update.storyboard){if(!creating&&project.shots.length)throw new Error('已有分镜不能全量storyboard覆盖；请添加/删除/重排');const storyboard=object(update.storyboard),items=array(storyboard.shots,'storyboard.shots');if(items.length<1||items.length>12)throw new Error('创作镜头数量须为1–12');checkAssets(items,project);const sources=array(update.sourcesByIndex,'sourcesByIndex');if(sources.length!==items.length)throw new Error('每个镜头都需要一份源码');project.shots=normalizeStoryboard(storyboard,project);project.shotOrder=project.shots.map(s=>s.id);delete project.extensions.graphEdges;project.shots.forEach((shot,index)=>{project.graph.positions[shot.id]=[420+index*340,160];sourceMap.set(shot.id,scene(sources[index]));});}
      for(const rawNew of update.addShots===undefined?[]:array(update.addShots,'addShots')){if(!allowStructural(input,intent))throw new Error('用户未要求添加镜头');const entry=object(rawNew),spec=entry.shot?object(entry.shot):entry;checkAssets([spec],project);const seconds=Number(spec.durationSeconds??6);if(!Number.isFinite(seconds)||seconds<=0||seconds>3600)throw new Error('新增镜头时长无效');const shot=normalizeStoryboard({shots:[spec]},{...project,targetDuration:seconds})[0]!;
        const alias=entry.tempId===undefined?undefined:text(entry.tempId,'tempId');if(alias){if(aliases.has(alias)||project.shots.some(s=>s.id===alias))throw new Error('新增镜头别名重复');aliases.set(alias,shot.id);}const after=entry.afterId===undefined?undefined:resolveId(entry.afterId);project=addShot(project,shot,after);sourceMap.set(shot.id,scene(entry.source??spec.source));}
      for(const rawId of update.deleteShotIds===undefined?[]:array(update.deleteShotIds,'deleteShotIds')){if(!allowStructural(input,intent))throw new Error('用户未要求删除镜头');const id=resolveId(rawId);checkScope(id);project=deleteShot(project,id);sourceMap.delete(id);}
      for(const rawPatch of update.shotPatches===undefined?[]:array(update.shotPatches,'shotPatches')){const item=object(rawPatch),id=resolveId(item.id??item.shotId);checkScope(id);const shot=project.shots.find(s=>s.id===id);if(!shot)throw new Error('镜头ID不存在');const patch={...object(item.patch)};
        for(const key of Object.keys(patch))if(!['title','intent','composition','action','narration','durationFrames','durationSeconds','transition','assetIds','referenceIds','params'].includes(key))throw new Error('不支持的镜头字段：'+key);
        if(patch.durationSeconds!==undefined){patch.durationFrames=Math.round(Number(patch.durationSeconds)*project.target.fps.num/project.target.fps.den);delete patch.durationSeconds;}
        if(patch.title!==undefined&&!/(?:标题|名称).*(?:改|设|换)|(?:改|设|换).*(?:标题|名称)|改名|命名/.test(input.message)&&!creating)delete patch.title;
        if(patch.params)patch.params={...shot.params,...object(patch.params)};project=updateShot(project,id,patch as Partial<Shot>);}
      for(const rawBinding of update.assetBindings===undefined?[]:array(update.assetBindings,'assetBindings')){const binding=object(rawBinding),id=resolveId(binding.shotId);checkScope(id);const assetId=text(binding.assetId,'assetId'),kind=binding.kind??'asset';if(!['asset','reference'].includes(String(kind)))throw new Error('素材绑定类型无效');project=binding.remove===true?unbindAsset(project,id,assetId,kind as 'asset'|'reference'):bindAsset(project,id,assetId,kind as 'asset'|'reference');}
      if(update.shotOrder){if(!allowStructural(input,intent))throw new Error('用户未要求重排镜头');project=reorderShots(project,array(update.shotOrder,'shotOrder').map(resolveId));}
      for(const rawSource of update.sources===undefined?[]:array(update.sources,'sources')){const item=object(rawSource),id=resolveId(item.shotId);checkScope(id);if(!project.shots.some(s=>s.id===id))throw new Error('源码引用的镜头不存在');sourceMap.set(id,scene(item.source));}
      if(update.audioClips!==undefined)project.audioClips=structuredClone(array(update.audioClips,'audioClips')) as AudioClip[];
      if(update.selectedShotId!==undefined){const id=resolveId(update.selectedShotId);if(!project.shots.some(s=>s.id===id))throw new Error('所选镜头不存在');project.extensions.selectedShotId=id;}
      candidate=project;mutated=true;
    }else if(tool==='video_inspect'){if(args.shotId!==undefined&&!snapshot.project?.shots.some(s=>s.id===args.shotId))throw new Error('检查镜头不存在');inspect.push({kind:'inspect',shotId:args.shotId,includeSource:args.includeSource===true});}
    else if(tool==='video_render'){if(!['preview','check'].includes(String(args.action)))throw new Error('对话工具仅支持preview/check；导出由界面发起');preview=true;}
    else if(tool==='video_audio'){if(intent==='chat'||intent==='discuss')throw new Error('讨论不能修改音轨');const project=ensure(),request=object(args.request??{});if(args.action==='remove'){const id=text(request.clipId,'clipId');if(!project.audioClips?.some(c=>c.id===id))throw new Error('音轨不存在');project.audioClips=project.audioClips.filter(c=>c.id!==id);}
      else if(args.action==='update'){const clip=project.audioClips?.find(c=>c.id===request.clipId);if(!clip)throw new Error('音轨不存在');const patch=object(request.patch);for(const key of Object.keys(patch))if(!['startSeconds','trimStart','trimEnd','volume','fadeIn','fadeOut','loop','role','shotId'].includes(key))throw new Error('音轨字段无效');Object.assign(clip,patch);}
      else if(args.action==='add'){const assetId=text(request.assetId,'assetId');if(!project.assets.some(a=>a.id===assetId&&a.kind==='audio'))throw new Error('请先导入音频素材');const clip:AudioClip={id:randomUUID(),assetId,role:(request.role??'voice') as AudioClip['role'],shotId:request.shotId as string|undefined,startSeconds:Number(request.startSeconds??0),trimStart:Number(request.trimStart??0),trimEnd:request.trimEnd as number|undefined,volume:Number(request.volume??1),fadeIn:Number(request.fadeIn??0),fadeOut:Number(request.fadeOut??0),loop:!!request.loop};project.audioClips=[...(project.audioClips??[]),clip];project.target.audioMode='mixed';}
      else throw new Error('对话音频仅支持已导入音轨的add/update/remove');mutated=true;
    }else throw new Error('导演计划包含未知工具：'+tool);
  }
  if((intent==='chat'||intent==='discuss')&&(mutated||preview))throw new Error('聊天/讨论不能修改或启动渲染');
  if(mutated){const project=ensure();if(!project.shots.length||project.shots.length>12)throw new Error('提交后镜头须为1–12个');const check=validateProject(project);if(!check.ok)throw new Error(check.errors.join('\n'));compileSpec(project);
    const previous=new Set(snapshot.project?.shots.map(s=>s.id)??[]);for(const shot of project.shots)if(!previous.has(shot.id)&&!sourceMap.has(shot.id))throw new Error('新增镜头缺少源码');
    if(creating||!snapshot.project?.shots.length){const positions=project.shots.map(shot=>project.graph.positions[shot.id]??[0,160]);const rightmost=positions.reduce((right,position)=>position[0]>right[0]?position:right,[0,160]);project.graph.positions['film-output']=[rightmost[0]+370,rightmost[1]];}
    project.revision=creating?0:snapshot.project!.revision;}
  return {intent,reply:typeof plan.message==='string'?plan.message:'已处理当前请求。',candidate,sources:[...sourceMap].map(([shotId,source])=>({shotId,source})),mutated,create:creating,preview:preview||mutated,inspect};
}

export async function authorizedImages(snapshot:StudioSnapshot,input:ChatInput,config:ProviderConfig,signal:AbortSignal):Promise<{content:ModelContent[];ids:string[]}>{
  const requested=input.imageAssetIds??[];if(!input.allowImageUpload||!config.enableVision||!config.supportsVision)return {content:[],ids:[]};
  if(!snapshot.project||!snapshot.root)throw new Error('请先导入当前工程的图片');if(!requested.length)return {content:[],ids:[]};
  if(new Set(requested).size!==requested.length||requested.length>Math.min(3,config.maxVisionImages??3))throw new Error('每轮最多明确选择3张不同图片');
  const selected=selectedShots(snapshot.project,input);const allowed=selected.length?new Set(selected.flatMap(s=>[...s.assetIds,...s.referenceIds])):new Set(requested);let total=0;const content:ModelContent[]=[];
  for(const id of requested){signal.throwIfAborted();if(!allowed.has(id))throw new Error('图片未绑定到本轮选中镜头，不能自动扩大发送范围');const asset=snapshot.project.assets.find(a=>a.id===id&&a.kind==='image');if(!asset?.path)throw new Error('图片资产不存在');const path=await projectPath(snapshot.root,asset.path),info=await stat(path);if(!info.isFile())throw new Error('图片素材必须是文件');const byteLimit=Math.min(6*1024*1024,config.maxVisionBytes??6*1024*1024);if(info.size<=0||total+info.size>byteLimit)throw new Error('图片总量超过6MB或配置上限');const buffer=await readFile(path);signal.throwIfAborted();total+=buffer.length;if(!buffer.length||total>byteLimit)throw new Error('图片读取后的总量超过6MB或配置上限');const metadata=imageMetadata(buffer);if(metadata.width<1||metadata.height<1||Math.max(metadata.width,metadata.height)>(config.maxVisionDimension??4096)||metadata.width*metadata.height>16_777_216)throw new Error('图片像素尺寸超过上限；请先导入较小图片');content.push({type:'text',text:`本轮明确发送资产 ${id}（${asset.name}）像素，${metadata.width}×${metadata.height}`},{type:'image_url',image_url:{url:`data:${metadata.mime};base64,${buffer.toString('base64')}`,detail:'auto'}});}
  return {content,ids:[...requested]};
}

export function validateChatInput(input:ChatInput):void {
  if(!input||typeof input.sessionId!=='string'||!input.sessionId.trim()||typeof input.operationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.operationId)||!Object.hasOwn(input,'expectedRevision')||input.expectedRevision!==null&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0))throw Object.assign(new Error('对话请求必须提供 sessionId、operationId 和 expectedRevision'),{code:'AGENT_CONTEXT_REQUIRED'});
  if(input.projectId&&input.expectedRevision===null)throw Object.assign(new Error('已有工程必须提供 expectedRevision'),{code:'REVISION_REQUIRED'});
}
const externalTools=new Set(['agent_delegate','agent_wait','agent_result','agent_cancel','agent_accept']);
const fail=(code:string,message:string)=>Object.assign(new Error(message),{code});


/** Three-way merge keeps child source artifacts local and refuses overlapping edits. */
export function mergeAcceptedCandidates(base:VideoProject,current:VideoProject,sources:{shotId:string;source:SceneSource}[],accepted:AgentCandidatePayload[]){
  const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  const merge=(original:any,left:any,right:any,path:string):any=>{
    if(equal(original,right))return structuredClone(left);if(equal(original,left)||equal(left,right))return structuredClone(right);
    if(Array.isArray(original)&&Array.isArray(left)&&Array.isArray(right)&&[...original,...left,...right].every(item=>item&&typeof item==='object'&&typeof item.id==='string')){
      const ids=[...new Set([...left,...right].map(item=>item.id))];return ids.map(id=>merge(original.find((item:any)=>item.id===id),left.find((item:any)=>item.id===id),right.find((item:any)=>item.id===id),path+'.'+id)).filter(item=>item!==undefined);
    }
    if(original&&left&&right&&typeof original==='object'&&typeof left==='object'&&typeof right==='object'&&!Array.isArray(original)&&!Array.isArray(left)&&!Array.isArray(right))return Object.fromEntries([...new Set([...Object.keys(original),...Object.keys(left),...Object.keys(right)])].map(key=>[key,merge(original[key],left[key],right[key],path+'.'+key)]).filter(([,value])=>value!==undefined));
    throw fail('CANDIDATE_SCOPE_CONFLICT','成员候选与当前计划重复修改 '+path+'，请重新规划');
  };
  let project=structuredClone(current);const result=new Map(sources.map(item=>[item.shotId,item.source]));
  for(const candidate of accepted){if(candidate.project.id!==base.id||candidate.baseRevision!==base.revision)throw fail('REVISION_CONFLICT','成员候选基线与当前工程不一致');project=merge(base,project,candidate.project,'project');for(const [shotId,source]of Object.entries(candidate.sources)){if(result.has(shotId)&&!equal(result.get(shotId),source))throw fail('CANDIDATE_SCOPE_CONFLICT','成员候选与当前计划重复修改镜头源码 '+shotId);result.set(shotId,structuredClone(source));}}
  return {project,sources:[...result].map(([shotId,source])=>({shotId,source}))};
}

/** One isolated session. The facade supplies durable cross-process task/lease hooks. */
export class ConversationService {
  private releaseModel?:()=>void;private controller?:AbortController;private running?:Promise<unknown>;
  private activeTurnId?:string;private activeProjectId?:string;private ownedTaskId?:string;
  private writes:Promise<void>=Promise.resolve();private cancelWork:Promise<unknown>=Promise.resolve();
  private sessionId?:string;private turn?:ConversationTurn;
  constructor(private backend:BackendPort,private providers:ProviderManager,private dataDirectory:string,private options:ConversationServiceOptions={}){this.sessionId=options.sessionId;}
  private filename(){return join(this.dataDirectory,'conversations-v2',createHash('sha256').update(this.sessionId??'default').digest('hex')+'.json');}
  private persist(conversation:Conversation){
    conversation.sessionId=this.sessionId;conversation.schemaVersion=2;
    if(this.options.execution?.save)return this.options.execution.save(structuredClone(conversation));
    const saved=structuredClone(conversation),work=this.writes.then(async()=>{await mkdir(join(this.dataDirectory,'conversations-v2'),{recursive:true});const path=this.filename(),temporary=path+'.tmp-'+randomUUID();await writeFile(temporary,JSON.stringify(saved,null,2)+'\n');await rename(temporary,path);});this.writes=work.catch(()=>{});return work;
  }
  async history(projectId?:string):Promise<Conversation>{
    let conversation:Conversation|undefined;
    if(this.options.execution?.load)conversation=await this.options.execution.load();
    else try{conversation=JSON.parse(await readFile(this.filename(),'utf8')) as Conversation;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(conversation){if(!conversation.id||!Array.isArray(conversation.messages)||conversation.sessionId&&conversation.sessionId!==this.sessionId)throw new Error('会话记录身份或格式无效');return structuredClone(conversation);}
    return {id:randomUUID(),sessionId:this.sessionId,schemaVersion:2,...(projectId?{projectId}:{}),messages:[],turns:[],provider:'custom',model:(await this.providers.settings()).config.model};
  }
  private async phase(status:AgentTaskStatus,patch:Record<string,unknown>={}){if(this.turn)this.turn.phase=status;await this.options.execution?.phase?.(status,patch);}
  private async reserve(kind:'modelCalls'|'toolCalls',amount=1){
    if(this.turn){this.turn[kind]=(this.turn[kind]??0)+amount;if(this.turn[kind]!>(kind==='modelCalls'?12:128))throw fail('AGENT_BUDGET_EXCEEDED','本轮调用预算已用尽');}
    await this.options.execution?.reserve?.({[kind]:amount});
  }
  private cancelOwned(){const projectId=this.activeProjectId,taskId=this.ownedTaskId;if(projectId&&taskId)this.cancelWork=this.backend.call('cancel',{projectId,expectedTaskId:taskId}).catch(()=>{});}
  cancel():void{this.controller?.abort(new Error('用户已取消对话'));this.cancelOwned();}
  activity(){return {running:!!this.controller,sessionId:this.sessionId,turnId:this.activeTurnId,projectId:this.activeProjectId,taskId:this.options.execution?.taskId??this.ownedTaskId,phase:this.turn?.phase};}
  hasActiveTurn():boolean{return !!this.controller;}
  async shutdown():Promise<void>{this.cancel();await this.running?.catch(()=>{});await this.cancelWork;await this.writes;}
  async send(input:ChatInput):Promise<{conversation:Conversation;snapshot:StudioSnapshot}>{
    validateChatInput(input);if(this.sessionId&&this.sessionId!==input.sessionId)throw fail('SESSION_SCOPE_VIOLATION','请求不属于当前会话');this.sessionId=input.sessionId;
    if(this.controller)throw fail('SESSION_BUSY','此会话已有任务进行中，请等待或取消');
    const controller=new AbortController();this.controller=controller;const running=this.run(input,controller);this.running=running;
    try{return await running;}finally{this.releaseModel?.();this.releaseModel=undefined;this.controller=undefined;this.activeTurnId=undefined;this.activeProjectId=undefined;this.ownedTaskId=undefined;this.running=undefined;this.turn=undefined;}
  }
  private async validate(snapshot:StudioSnapshot,project:VideoProject,sources:{shotId:string;source:SceneSource}[],signal:AbortSignal):Promise<ValidationReceipt>{
    signal.throwIfAborted();await this.phase('validating');await this.reserve('toolCalls');
    const input={projectId:snapshot.project?.id,expectedRevision:snapshot.project?.revision??null,candidate:{project,sources:Object.fromEntries(sources.map(item=>[item.shotId,item.source]))},signal};
    const receipt=this.options.execution?.validate?await this.options.execution.validate(input):await this.backend.call<ValidationReceipt>('candidate.validate',input);
    signal.throwIfAborted();if(!receipt||receipt.status!=='passed'||!receipt.id||!receipt.candidateHash||receipt.baseRevision!==(snapshot.project?.revision??0)||['structure','syntax','assets','runtime'].some(id=>!receipt.checks?.some(check=>check.id===id&&check.status==='passed')))throw fail('CANDIDATE_VALIDATION_FAILED','候选运行验证未通过：'+(receipt?.checks?.filter(check=>check.status==='failed').map(check=>check.message??check.id).join('；')||'缺少有效验证回执'));
    if(this.turn)this.turn.validation=receipt;return receipt;
  }
  private async mutate(endpoint:'create'|'apply',payload:Record<string,unknown>,input:ChatInput,signal:AbortSignal):Promise<StudioSnapshot>{
    signal.throwIfAborted();await this.options.execution?.assertComplete?.();await this.phase('committing');await this.reserve('toolCalls');
    const {validationId:_validationId,...candidatePayload}=payload,logicalPayload={endpoint,...candidatePayload};
    const commitId=(this.options.execution?.taskId??input.operationId)+'.commit.'+contentHash(logicalPayload).slice(0,16);
    const metadata=this.options.execution?.mutation?await this.options.execution.mutation(commitId,logicalPayload):{operation:{id:commitId,payloadHash:contentHash(logicalPayload)}};
    signal.throwIfAborted();const saved=await this.backend.call<StudioSnapshot>(endpoint,{...payload,...metadata,sessionId:input.sessionId,operationId:input.operationId});
    if(this.turn&&saved.project){this.turn.committedRevision=saved.project.revision;this.turn.request.projectId=saved.project.id;await this.phase('reconciling',{committedRevision:saved.project.revision,checkpoint:'committed'});}
    return saved;
  }
  private async run(original:ChatInput,controller:AbortController):Promise<{conversation:Conversation;snapshot:StudioSnapshot}>{
    let conversation=await this.history(original.projectId);if(conversation.projectId&&original.projectId!==conversation.projectId)throw fail('SESSION_SCOPE_VIOLATION','会话工程与请求工程不一致');
    const requestHash=this.options.execution?.requestHash??contentHash(original);
    const duplicate=conversation.turns?.find(turn=>turn.operationId===original.operationId);
    if(duplicate&&(duplicate.requestHash??contentHash(duplicate.request))!==requestHash)throw fail('OPERATION_MISMATCH','同一 operationId 对应不同请求');
    if(duplicate?.status==='succeeded')return {conversation,snapshot:await this.backend.call('current',conversation.projectId?{projectId:conversation.projectId}:{})};
    if(duplicate&&!original.retryTurnId)throw fail('OPERATION_ALREADY_RECORDED','此操作已有回执，请继续原任务或使用新的 operationId');
    const retry=original.retryTurnId?conversation.turns?.find(turn=>turn.id===original.retryTurnId):undefined;
    if(original.retryTurnId&&!retry)throw fail('TURN_NOT_FOUND','重试回合不存在');if(retry?.status==='pending')throw fail('SESSION_BUSY','该回合仍在运行');
    let input:ChatInput=retry?{...retry.request,...original,message:original.message.trim()||retry.request.message}:structuredClone(original);
    if(!input.message?.trim()||input.message.length>20000)throw new Error('制作请求须为1–20,000字符');
    const fixture=input.provider===DEMO_PROVIDER&&this.providers.fixtureEnabled(),selection=input.role??{provider:input.provider,model:input.model};
    const settings=await this.providers.settings(fixture?undefined:selection),resume=await this.options.execution?.reconcile?.();
    const committedRevision=retry?.committedRevision??resume?.committedRevision;
    if(committedRevision===undefined&&!fixture&&!(settings.ready??settings.hasKey))throw new Error(settings.credentialStatus?.error??'请先在模型设置中配置当前应用的API Key；本轮没有创建或修改工程');
    if(committedRevision===undefined&&!fixture){const route=await this.providers.registry.resolve(selection);this.releaseModel=this.providers.registry.acquire(route.connection.id,route.model.id);}
    if(!fixture&&settings.route)input={...input,...settings.route};
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.min(900000,(settings.config.requestTimeoutMs??90000)*4+30000))]);
    const now=new Date().toISOString(),turn:ConversationTurn={id:randomUUID(),request:structuredClone(input),operationId:input.operationId,requestHash,taskId:this.options.execution?.taskId,status:'pending',phase:'preflight',createdAt:now,updatedAt:now,modelCalls:0,toolCalls:0,...(retry?{retryOf:retry.id}:{})};
    this.turn=turn;this.activeTurnId=turn.id;conversation.provider=input.provider;conversation.model=input.model;conversation.turns??=[];conversation.turns.push(turn);conversation.messages.push(message('user',input.message,turn.id,'pending'));await this.persist(conversation);
    let snapshot:StudioSnapshot;let committed=committedRevision!==undefined;
    try{
      signal.throwIfAborted();await this.phase('preflight');snapshot=await this.backend.call('current',input.projectId?{projectId:input.projectId}:{});if(!input.projectId)snapshot={...snapshot,project:null,root:null,task:null,previewUrl:null,previewRevision:null};this.activeProjectId=snapshot.project?.id;
      if(input.projectId&&snapshot.project?.revision!==input.expectedRevision||!input.projectId&&input.expectedRevision!==null)throw fail('REVISION_CONFLICT','工程版本已变化，请刷新后发起请求');
      let reply:string;
      if(committedRevision!==undefined){
        if(!snapshot.project||snapshot.project.revision<committedRevision)throw fail('COMMIT_RECEIPT_MISMATCH','已提交回合无法与当前工程对账，请检查历史版本');
        turn.committedRevision=committedRevision;await this.validate(snapshot,snapshot.project,[],signal);reply='已重新验证已提交工程；本次没有重复执行原制作动作。';
      }else{
        const images=await authorizedImages(snapshot,input,settings.config,signal);turn.imageAssetIds=images.ids;await this.persist(conversation);
        const result=fixture?await this.fixture(snapshot,input,signal):await this.direct(conversation,snapshot,input,inferIntent(input,!!snapshot.project?.shots.length),settings.config,images,signal);
        snapshot=result.snapshot;reply=result.reply;committed=result.committed;
      }
      if(committed&&snapshot.project){turn.committedRevision??=snapshot.project.revision;turn.request.projectId=snapshot.project.id;this.activeProjectId=snapshot.project.id;const wasUnbound=!conversation.projectId;conversation.projectId=snapshot.project.id;if(wasUnbound)await this.options.execution?.projectCreated?.(snapshot.project.id,conversation);reply+=' 工程与对应候选运行验证回执已确认。';}
      if(!turn.imageAssetIds?.length&&/(?:看过|查看|分析|识别).*(?:图像|图片|截图|PNG)|视觉检查/.test(reply))reply='已依据文字、工程规范和运行诊断处理本轮；本轮未发送图片像素给模型。';
      await this.options.execution?.assertComplete?.();
      turn.status='succeeded';turn.updatedAt=new Date().toISOString();turn.phase='succeeded';for(const item of conversation.messages)if(item.turnId===turn.id)item.status='succeeded';
      conversation.messages.push(message('assistant',reply,turn.id,'succeeded',committed&&snapshot.project?[{label:'查看当前工程',projectId:snapshot.project.id,revision:snapshot.project.revision,frame:0}]:undefined));await this.persist(conversation);await this.phase('succeeded',{committedRevision:turn.committedRevision,checkpoint:'complete'});return {conversation:structuredClone(conversation),snapshot};
    }catch(error){
      const receipt=await this.options.execution?.reconcile?.().catch(()=>undefined);if(receipt?.committedRevision!==undefined){turn.committedRevision=receipt.committedRevision;committed=true;}
      turn.status=signal.aborted?'cancelled':'failed';turn.error=errorText(error);turn.updatedAt=new Date().toISOString();
      const code=(error as {code?:string}).code;const status:AgentTaskStatus=signal.aborted?'cancelled':code==='CHILDREN_PENDING'?'blocked':code==='AGENT_NO_PROGRESS'?'stalled':code==='REVISION_CONFLICT'?'awaiting-rebase':committed?'paused':'failed';
      await this.phase(status,{error:turn.error,committedRevision:turn.committedRevision,checkpoint:committed?'needs-validation':'failed'}).catch(()=>{});
      for(const item of conversation.messages)if(item.turnId===turn.id)item.status=turn.status;
      conversation.messages.push(message('assistant',(committed?`工程 v${turn.committedRevision} 已保存，`:'')+'本轮未完成：'+turn.error,turn.id,turn.status));await this.persist(conversation);throw error;
    }
  }
  private async preview(snapshot:StudioSnapshot,signal:AbortSignal):Promise<StudioSnapshot>{
    if(!snapshot.project)throw new Error('请先创建工程');await this.validate(snapshot,snapshot.project,[],signal);return snapshot;
  }
  private async direct(conversation:Conversation,snapshot:StudioSnapshot,input:ChatInput,requested:Intent|'auto',config:ProviderConfig,images:{content:ModelContent[];ids:string[]},signal:AbortSignal):Promise<{snapshot:StudioSnapshot;reply:string;committed:boolean}>{
    const limit=config.contextMessageLimit??24,maxChars=config.contextCharLimit??90000;let remaining=Math.floor(maxChars*.45);const turns:ModelMessage[]=[];
    for(const item of [...conversation.messages].reverse()){if(turns.length>=limit)break;const content=item.content.slice(0,Math.min(remaining,20000));if(!content)break;remaining-=content.length;turns.unshift({role:item.role,content});}
    const restored=await this.options.execution?.restoreAccepted?.(signal);if(restored?.snapshot)snapshot=restored.snapshot;
    const receipts:Obj[]=(conversation.turns??[]).filter(turn=>turn!==this.turn&&turn.taskId&&turn.taskId===this.turn?.taskId).flatMap(turn=>turn.toolReceipts??[]).slice(-16),collected:unknown[]=[],accepted:AgentCandidatePayload[]=restored?.candidates??[];let previousAttempt='',repeated=0;const maxRounds=4;
    for(let round=0;round<maxRounds;round++){
      signal.throwIfAborted();await this.phase('planning',{checkpoint:'round-'+round});
      const context={requestedIntent:requested,request:input.message,project:snapshot.project,selectedShotIds:snapshot.project?selectedShots(snapshot.project,input).map(shot=>shot.id):[],imageEvidence:{sentAssetIds:images.ids,pixelsSent:images.ids.length>0},receipts,remainingRounds:maxRounds-round};
      const contextText=JSON.stringify(context);if(contextText.length>Math.floor(maxChars*.75))throw new Error('工程上下文超过模型设置上限，请提高上下文限制或缩小工程内容');
      if(images.content.length)for(const previous of turns)if(Array.isArray(previous.content))previous.content=previous.content.filter(part=>part.type==='text');
      turns.push({role:'user',content:images.content.length?[{type:'text',text:'当前上下文：'+contextText},...images.content]:'当前上下文：'+contextText});
      const system=DIRECTOR+'\n'+packBriefContext(input.packId),size=(item:ModelMessage)=>typeof item.content==='string'?item.content.length:item.content.reduce((total,part)=>total+(part.type==='text'?part.text.length:0),0);
      let requestSize=system.length+turns.reduce((total,item)=>total+size(item),0);while(requestSize>maxChars&&turns.length>1)requestSize-=size(turns.shift()!);if(requestSize>maxChars)throw new Error('当前工程与导演提示超过上下文上限');
      await this.reserve('modelCalls');const raw=await this.providers.complete(turns,system,signal,config.maxTokens,{provider:input.provider,model:input.model},input.sessionId);turns.push({role:'assistant',content:raw});
      const signature=createHash('sha256').update(raw+'|'+snapshot.project?.revision+'|'+JSON.stringify(receipts.at(-1))).digest('hex');repeated=signature===previousAttempt?repeated+1:0;previousAttempt=signature;
      if(repeated>=1)throw fail('AGENT_NO_PROGRESS','相同计划在相同工程版本上重复，未产生新进展；请缩小或调整请求');
      try{
        const plan=parseModelJson(raw);if(typeof plan.done!=='boolean')throw new Error('导演计划须提供布尔 done');const actions=array(plan.actions??[],'actions');
        const delegated=actions.filter(raw=>externalTools.has(String(object(raw).tool)));
        if(delegated.length){
          if(!this.options.execution?.externalTool)throw new Error('当前会话未启用内置子代理');
          if(delegated.length!==actions.length||collected.length)throw new Error('子代理工具与工程写计划必须分轮执行');
          for(const rawAction of delegated){
            signal.throwIfAborted();const action=object(rawAction);await this.reserve('toolCalls');await this.phase('executing');const result=await this.options.execution.externalTool(String(action.tool),object(action.arguments??{}),signal);const envelope=result&&typeof result==='object'?result as {receipt?:unknown;acceptedCandidate?:AgentCandidatePayload;snapshot?:StudioSnapshot}:undefined;
            if(envelope?.acceptedCandidate){
              const changedRevision=envelope.snapshot?.project?.revision!==undefined&&envelope.snapshot.project.revision!==snapshot.project?.revision;
              if(changedRevision&&accepted.length){const refreshed=await this.options.execution.restoreAccepted?.(signal);if(!refreshed?.snapshot)throw fail('REVISION_CONFLICT','成员候选基线已变化，需要重新验证全部产物');accepted.splice(0,accepted.length,...refreshed.candidates);snapshot=refreshed.snapshot;}
              else{accepted.push(envelope.acceptedCandidate);if(envelope.snapshot)snapshot=envelope.snapshot;}
              if(changedRevision)collected.length=0;
            }
            const visible=envelope&&Object.hasOwn(envelope,'receipt')?envelope.receipt:result;const serialized=JSON.stringify(visible);const storedReceipt={status:'tool-result',tool:action.tool,result:serialized.length>24000?serialized.slice(0,24000)+' [TRUNCATED]':visible};receipts.push(storedReceipt);if(this.turn){this.turn.toolReceipts??=[];this.turn.toolReceipts.push(storedReceipt);await this.persist(conversation);}
          }
          continue;
        }
        const prepared=compileDirectorPlan({...plan,actions:[...collected,...actions]},snapshot,input,requested);
        if(plan.done&&!prepared.inspect.length){
          if(accepted.length){if(!snapshot.project)throw new Error('成员候选必须属于已有工程');const merged=mergeAcceptedCandidates(snapshot.project,prepared.candidate??snapshot.project,prepared.sources,accepted);prepared.candidate=merged.project;prepared.sources=merged.sources;prepared.mutated=true;}
          const requiresWork=['create','modify'].includes(requested)||['create','modify'].includes(prepared.intent);
          const sameProject=prepared.candidate&&snapshot.project&&JSON.stringify(prepared.candidate)===JSON.stringify(snapshot.project);
          if(requiresWork&&(!prepared.mutated||sameProject&&!prepared.sources.length))throw fail('TASK_NOT_SATISFIED','修改请求没有产生可验证的修改，不能标记完成');
          if(prepared.mutated){
            if(prepared.create&&input.projectId)throw fail('SESSION_SCOPE_VIOLATION','当前会话已绑定工程；请在新的未绑定会话中创建另一影片');
            const receipt=await this.validate(snapshot,prepared.candidate!,prepared.sources,signal);
            const payload={expectedRevision:snapshot.project?.revision??null,project:prepared.candidate!,sources:prepared.sources,validationId:receipt.id,...(!prepared.create?{projectId:snapshot.project!.id}:{})};
            try{snapshot=await this.mutate(prepared.create?'create':'apply',payload,input,signal);}
            catch(error){if((error as {code?:string}).code==='REVISION_CONFLICT'&&round<maxRounds-1){snapshot=await this.backend.call('current',{projectId:snapshot.project?.id});collected.length=0;
              if(accepted.length){try{const refreshed=await this.options.execution?.restoreAccepted?.(signal);if(!refreshed?.snapshot)throw fail('REVISION_CONFLICT','成员候选需要重新验证后才能合并');accepted.splice(0,accepted.length,...refreshed.candidates);snapshot=refreshed.snapshot;}catch(failure){throw Object.assign(failure instanceof Error?failure:new Error(errorText(failure)),{commitFailure:true});}}
              receipts.push({status:'error',code:'REVISION_CONFLICT',committed:false,currentRevision:snapshot.project?.revision});turns.push({role:'user',content:'后端事务拒绝本轮计划，请依据最新工程重新合并'});continue;}throw Object.assign(error instanceof Error?error:new Error(errorText(error)),{commitFailure:true});}
          }else if(prepared.preview&&snapshot.project)snapshot=await this.preview(snapshot,signal);
          return {snapshot,reply:prepared.reply,committed:prepared.mutated};
        }
        collected.push(...actions.filter(raw=>{const action=object(raw);return action.tool!=='video_inspect'&&!(action.tool==='video_project'&&object(action.arguments??{}).action!=='create');}));
        for(const inspect of prepared.inspect){await this.reserve('toolCalls');const result=inspect.kind==='project'?{project:snapshot.project}:await this.backend.call('inspect',{projectId:snapshot.project?.id,shotId:inspect.shotId,includeSource:inspect.includeSource});const serialized=JSON.stringify(result);receipts.push({status:'read',result:serialized.length>45000?serialized.slice(0,45000)+' [TRUNCATED]':result});}
        turns.push({role:'user',content:'读取已实际执行，修改尚未提交。依据真实回执完成计划，不重复未提交动作。'});
      }catch(error){if(round===maxRounds-1||(error as {commitFailure?:boolean}).commitFailure)throw error;receipts.push({status:'error',message:errorText(error),committed:false});turns.push({role:'user',content:'计划未提交，格式或工具校验错误，请修复完整计划：'+errorText(error)});collected.length=0;}
    }
    throw fail('AGENT_ROUND_LIMIT','导演计划超过4轮上限，请缩小请求后重试');
  }
  private async fixture(snapshot:StudioSnapshot,input:ChatInput,signal:AbortSignal){
    if(input.model!==DEMO_MODEL)throw new Error('fixture模型名称无效');const candidate=snapshot.project?structuredClone(snapshot.project):createProject(shortTopic(input.message),shortTopic(input.message));let sources:{shotId:string;source:SceneSource}[]=[];
    if(!candidate.shots.length||!snapshot.project){candidate.shots=demoStoryboard(candidate);candidate.shotOrder=candidate.shots.map(shot=>shot.id);sources=candidate.shots.map((shot,index)=>({shotId:shot.id,source:demoSceneSource(index)}));}
    else for(const shot of selectedShots(candidate,input))Object.assign(shot,demoPatch(shot,input.message,candidate.target.fps.num/candidate.target.fps.den));
    const receipt=await this.validate(snapshot,candidate,sources,signal);snapshot=await this.mutate(snapshot.project?'apply':'create',{project:candidate,sources,expectedRevision:snapshot.project?.revision??null,validationId:receipt.id,...(snapshot.project?{projectId:snapshot.project.id}:{})},input,signal);
    return {snapshot,reply:'测试 fixture 已验证并提交可编辑场景；该路径不进入正常供应商目录。',committed:true};
  }
}

export function demoPatch(shot:Shot,value:string,fps:number):Partial<Shot>{const patch:Partial<Shot>={},params={...shot.params};let changed=false;const colors:Record<string,string>={黑色:'#101010',白色:'#ffffff',蓝色:'#183c66',红色:'#7a2633',绿色:'#163f35',紫色:'#382554',橙色:'#754323',黄色:'#6e5b20'};const hex=value.match(/#[a-fA-F0-9]{6}\b/),name=Object.keys(colors).find(c=>value.includes(c));if(hex||name){params.background=hex?.[0]??colors[name!]!;changed=true;}const motion=/缩放|zoom/i.test(value)?'zoom':/滑入|滑动|slide/i.test(value)?'slide':/淡入|fade/i.test(value)?'fade':/无动画|静止|none/i.test(value)?'none':undefined;if(motion){params.motion=motion;changed=true;}const seconds=value.match(/(\d+(?:\.\d+)?)\s*秒/);if(seconds)patch.durationFrames=Math.max(1,Math.round(Number(seconds[1])*fps));const title=value.match(/(?:标题|名称)\s*(?:改为|改成|设为|设成|换成|[:：])\s*[“「"']?([^”」"'，,。；;\n]+)/);if(title){patch.title=title[1]!.trim();params.text=patch.title;changed=true;}if(changed)patch.params=params;return patch;}
