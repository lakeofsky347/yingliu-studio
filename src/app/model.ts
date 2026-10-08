import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSceneSource, defaultShot, normalizeSceneDurations } from '../core/index.ts';
import type { SceneSource, Shot, VideoProject } from '../shared/types.ts';
import type { ProviderConfig, ProviderHost, ProviderSettings, SecretStore } from './contracts.ts';
import { inspectCredential, updateCredential } from './secrets.ts';

export const DEMO_PROVIDER = 'demo';
export const DEMO_MODEL = 'offline-director';
const KEY_REF = 'yingliu.custom-model.api-key';
const DEFAULT:ProviderConfig={id:'custom',name:'DeepSeek / 兼容接口',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',supportsVision:false,
  temperature:.7,maxTokens:7000,requestTimeoutMs:90000,contextMessageLimit:24,contextCharLimit:90000,enableVision:false,maxVisionImages:3,maxVisionBytes:6*1024*1024,maxVisionDimension:4096};
export type ModelContent={type:'text';text:string}|{type:'image_url';image_url:{url:string;detail?:'auto'|'low'|'high'}};
export type ModelMessage={role:'system'|'user'|'assistant';content:string|ModelContent[]};
type StreamOptions=Parameters<ProviderHost['stream']>[0];

function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function configuration(value:Partial<ProviderConfig>):ProviderConfig{
  const fields=Object.fromEntries(Object.entries(value).filter(([key])=>key in DEFAULT));const config={...DEFAULT,...fields,id:'custom'} as ProviderConfig;
  config.name=String(config.name).trim()||DEFAULT.name;config.model=String(config.model).trim();
  const url=new URL(String(config.baseUrl));
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('模型地址须为无凭据、查询参数或片段的 HTTP(S) 地址');
  config.baseUrl=url.href.replace(/\/$/,'');config.supportsVision=!!config.supportsVision;
  if(!config.model||config.model.length>200)throw new Error('请填写有效模型名称');
  const ranges:Record<string,[number,number]>={temperature:[0,2],maxTokens:[256,32768],requestTimeoutMs:[5000,300000],contextMessageLimit:[4,100],contextCharLimit:[8000,300000],maxVisionImages:[1,3],maxVisionBytes:[1024,6*1024*1024],maxVisionDimension:[64,4096]};
  for(const [key,[minimum,maximum]]of Object.entries(ranges)){const number=Number(config[key as keyof ProviderConfig]);if(!Number.isFinite(number)||number<minimum||number>maximum||key!=='temperature'&&!Number.isInteger(number))throw new Error(`模型参数 ${key} 须在 ${minimum}–${maximum} 范围内`);(config as unknown as Record<string,unknown>)[key]=number;}
  config.enableVision=!!config.enableVision;if(config.enableVision&&!config.supportsVision)throw new Error('请先确认所选模型支持图片输入，再启用图片发送');
  return config;
}
function turns(messages:unknown[],allowImages=false):ModelMessage[]{
  return messages.map(message=>{
    const item=object(message);const role=item.role==='assistant'?'assistant':item.role==='system'?'system':'user';
    const content=typeof item.content==='string'?item.content:Array.isArray(item.content)?item.content.map(block=>{const part=object(block);if(typeof part.text==='string')return {type:'text' as const,text:part.text};
      if(part.type==='image_url'){const image=object(part.image_url);if(!allowImages)throw new Error('图片发送未启用');if(typeof image.url!=='string'||!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(image.url))throw new Error('模型图片只允许当前工程验证后的内嵌 PNG/JPEG/WebP');return {type:'image_url' as const,image_url:{url:image.url,detail:'auto' as const}};}
      return {type:'text' as const,text:part.type==='image'?'[图片附件仅文字描述，未发送像素]':''};}).filter(part=>part.type==='image_url'||part.text):JSON.stringify(item.content??'');
    return {role,content};
  });
}
function finishReason(reason:unknown){return reason==='stop'?{kind:'stop'}:reason==='length'?{kind:'max-tokens'}:{kind:'failure',failure:{message:`模型未正常结束：${String(reason??'缺少完成原因')}`}};}

/** Configuration is local to this app; only the injected SecretStore handles the key. */
export class ProviderManager {
  private config:ProviderConfig={...DEFAULT};private mode:'demo'|'custom'='custom';private initialized?:Promise<void>;
  private writes:Promise<void>=Promise.resolve();
  constructor(private dataDirectory:string,private secrets:SecretStore,private options:{allowFixtures?:boolean;fetch?:typeof fetch}={}){}
  initialize():Promise<void>{return this.initialized??=(async()=>{
    try{const saved=object(JSON.parse(await readFile(join(this.dataDirectory,'provider.json'),'utf8')));this.config=configuration(object(saved.config));this.mode=saved.mode==='demo'&&this.options.allowFixtures?'demo':'custom';}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  })();}
  private async currentSettings():Promise<ProviderSettings>{return {config:structuredClone(this.config),...await inspectCredential(this.secrets,KEY_REF),mode:this.mode};}
  async settings():Promise<ProviderSettings>{await this.initialize();await this.writes;return this.currentSettings();}
  async save(input:Partial<ProviderConfig>&{apiKey?:string;mode?:'demo'|'custom'}):Promise<ProviderSettings>{
    await this.initialize();const captured=structuredClone(input);const work=this.writes.then(async()=>{
      const {apiKey,mode,...fields}=captured;const next=configuration({...this.config,...fields});
      if(mode!==undefined&&!['demo','custom'].includes(mode))throw new Error('模型模式无效');
      if(mode==='demo'&&!this.options.allowFixtures)throw new Error('离线 fixture 仅供测试，正常应用使用已配置的模型服务');
      const nextMode=mode??this.mode;await mkdir(this.dataDirectory,{recursive:true});
      const path=join(this.dataDirectory,'provider.json'),temporary=path+'.tmp-'+randomUUID();
      const commit=async()=>{await writeFile(temporary,JSON.stringify({version:2,config:next,mode:nextMode},null,2)+'\n');await rename(temporary,path);this.config=next;this.mode=nextMode;};
      try{if(apiKey===undefined)await commit();else await updateCredential(this.secrets,KEY_REF,apiKey.trim()||undefined,commit);}
      finally{await rm(temporary,{force:true});}return this.currentSettings();
    });this.writes=work.then(()=>undefined,()=>undefined);return work;
  }
  async check():Promise<{ok:boolean;message:string}>{
    const settings=await this.settings();if(settings.mode==='demo')return {ok:true,message:'离线演示模型可用；这是确定性演示，未连接远程模型。'};
    if(settings.credentialStatus&&!settings.credentialStatus.available)return {ok:false,message:settings.credentialStatus.error??'系统安全存储不可用，请解锁后重试。'};
    const key=await this.secrets.get(KEY_REF);if(!key)return {ok:false,message:'请先保存当前应用的模型 API Key。'};
    try{const response=await (this.options.fetch??fetch)(this.config.baseUrl+'/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok)return {ok:false,message:`模型目录检查失败（HTTP ${response.status}）；真实创作仍为 NOT_CHECKED。`};
      const value=object(await response.json()),models=Array.isArray(value.data)?value.data.map(x=>object(x).id):[];
      return models.includes(this.config.model)?{ok:true,message:'服务可访问，所选模型在目录中；此检查未执行真实创作，真实创作为 NOT_CHECKED。'}:{ok:true,message:'服务可访问；模型目录未确认所选名称，真实创作为 NOT_CHECKED。'};
    }catch(error){return {ok:false,message:`连接检查失败：${(error instanceof Error?error.message:'未知错误').split(key).join('[redacted]')}`};}
  }
  host():ProviderHost{return {
    listProviders:()=>[...(this.options.allowFixtures?[{id:DEMO_PROVIDER,name:'测试 fixture'}]:[]),{id:'custom',name:this.config.name}],
    listModels:async id=>{await this.initialize();if(id===DEMO_PROVIDER&&this.options.allowFixtures)return [{id:DEMO_MODEL,name:'测试 fixture',inputModalities:['text']}];if(id==='custom')return [{id:this.config.model,name:this.config.model,inputModalities:this.config.supportsVision&&this.config.enableVision?['text','image']:['text']}];throw new Error('未知模型供应商');},
    resolveModelInfo:async(id,model,signal)=>{signal?.throwIfAborted();if(id!==DEMO_PROVIDER&&id!=='custom'||id===DEMO_PROVIDER&&!this.options.allowFixtures||model!==(id===DEMO_PROVIDER?DEMO_MODEL:this.config.model))throw new Error('模型已变更，请重新选择');return {inputModalities:id==='custom'&&this.config.supportsVision&&this.config.enableVision?['text','image']:['text']};},
    stream:options=>this.stream(options),
  };}
  /** Full multi-turn text request, used by the app director. No PNG pixels are implied. */
  async complete(messages:ModelMessage[],system:string,signal:AbortSignal,maxTokens?:number):Promise<string>{
    await this.initialize();let result='',stopped=false;
    for await(const chunk of this.stream({provider:'custom',model:this.config.model,messages,system,maxTokens:maxTokens??this.config.maxTokens!,sessionId:'app-director',signal})){
      if(chunk.type==='text-delta')result+=chunk.text??'';
      if(chunk.type==='finish'){if(chunk.reason?.kind!=='stop')throw new Error(chunk.reason?.failure?.message??'模型输出不完整，请缩小修改范围');stopped=true;}
    }
    if(!stopped||!result.trim())throw new Error('模型没有返回完整文本');const key=await this.secrets.get(KEY_REF);return key?result.split(key).join('[redacted]'):result;
  }
  fixtureEnabled():boolean{return !!this.options.allowFixtures;}
  private async *stream(options:StreamOptions):ReturnType<ProviderHost['stream']>{
    await this.initialize();options.signal.throwIfAborted();
    if(options.provider===DEMO_PROVIDER){
      if(!this.options.allowFixtures)throw new Error('测试 fixture 未启用');
      if(options.model!==DEMO_MODEL)throw new Error('离线演示模型名称无效');
      const last=turns(options.messages).at(-1)?.content??'{}';let input:Record<string,unknown>;
      try{input=object(JSON.parse(typeof last==='string'?last:last.filter(part=>part.type==='text').map(part=>'text'in part?part.text:'').join('\n')));}catch{throw new Error('fixture只支持视频导演的结构化请求');}
      const project={topic:String(input.topic??object(input.video).topic??''),targetDuration:Number(input.durationSeconds??object(input.video).durationSeconds??18),target:object(input.target??object(input.video).target),assets:input.assets??[]} as unknown as VideoProject;
      const value=input.task==='storyboard'?{shots:demoStoryboard(project).map(s=>({...s,durationSeconds:s.durationFrames/(project.target.fps?.num/project.target.fps?.den||30)}))}:{...demoSceneSource(Number(object(input.shot).params&&object(object(input.shot).params).demoStage||0))};
      yield {type:'text-delta',text:JSON.stringify(value)};yield {type:'finish',reason:{kind:'stop'}};return;
    }
    if(options.provider!=='custom'||options.model!==this.config.model)throw new Error('请选择当前应用已配置的模型');
    const key=await this.secrets.get(KEY_REF);if(!key)throw new Error('当前应用未配置模型 API Key，请先打开模型设置');
    const signal=AbortSignal.any([options.signal,AbortSignal.timeout(this.config.requestTimeoutMs!)]);
    try{
    const normalized=turns(options.messages,this.config.supportsVision&&this.config.enableVision);let textSize=options.system.length,images=0,imageBytes=0;
    for(const turn of normalized){if(typeof turn.content==='string')textSize+=turn.content.length;else for(const part of turn.content){if(part.type==='text')textSize+=part.text.length;else{images++;imageBytes+=Buffer.from(part.image_url.url.slice(part.image_url.url.indexOf(',')+1),'base64').length;}}}
    if(textSize>this.config.contextCharLimit!)throw new Error('模型文本上下文超过配置上限');
    if(images>this.config.maxVisionImages!||imageBytes>this.config.maxVisionBytes!)throw new Error('模型图片数量或总字节超过配置上限');
    const response=await (this.options.fetch??fetch)(this.config.baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},signal,
      body:JSON.stringify({model:this.config.model,messages:[{role:'system',content:options.system},...normalized],max_tokens:Math.max(256,Math.min(this.config.maxTokens!,options.maxTokens)),temperature:this.config.temperature,stream:true})});
    if(!response.ok)throw new Error(`模型请求失败（HTTP ${response.status}）：${(await response.text()).slice(0,400).split(key).join('[redacted]')}`);
    if(!response.headers.get('content-type')?.includes('text/event-stream')){
      const data=object(await response.json()),choice=object(Array.isArray(data.choices)?data.choices[0]:undefined),message=object(choice.message);
      if(typeof message.content==='string')yield {type:'text-delta',text:message.content};yield {type:'finish',reason:finishReason(choice.finish_reason)};return;
    }
    if(!response.body)throw new Error('模型流式响应缺少内容');
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',finished=false,characters=0;
    try{while(true){signal.throwIfAborted();const next=await reader.read();pending+=decoder.decode(next.value,{stream:!next.done});
      const lines=pending.split('\n');pending=next.done?'':lines.pop()??'';if(next.done&&pending)lines.push(pending);
      for(const line of lines){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(!raw||raw==='[DONE]')continue;
        const data=object(JSON.parse(raw));if(data.error)throw new Error(String(object(data.error).message??'供应商流式错误'));
        const choice=object(Array.isArray(data.choices)?data.choices[0]:undefined),delta=object(choice.delta);
        if(typeof delta.content==='string'){characters+=delta.content.length;if(characters>400000)throw new Error('模型响应超出应用上限');yield {type:'text-delta',text:delta.content};}
        if(choice.finish_reason!==null&&choice.finish_reason!==undefined){finished=true;yield {type:'finish',reason:finishReason(choice.finish_reason)};}
      }
      if(next.done)break;
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!finished)throw new Error('模型连接结束但没有完成回执');
    }catch(error){if(options.signal.aborted)throw options.signal.reason;throw new Error((error instanceof Error?error.message:String(error)).split(key).join('[redacted]'));}
  }
}

/** An explicit synthetic fixture: topic-sensitive text, palette and editable code. */
export function demoStoryboard(project:VideoProject):Shot[]{
  const topic=project.topic.trim()||'一个新想法';const digest=createHash('sha256').update(topic).digest();
  const palette=['#8ee3c8','#c6a6ff','#ffd28a','#7fc9ff'][digest[0]!%4]!;
  const definitions=[['提出主题',topic,'从一个清楚的问题开始'],['拆开来看',topic+' · 观察与拆解','把复杂内容拆成可编辑的镜头'],['落到行动',topic+' · 下一步','调整节点、镜头文字和节奏，继续完善初稿']];
  const shots=definitions.map(([title,text,subtitle],index)=>{const shot=defaultShot(index,project.target.fps??{num:30,den:1});
    shot.title=`${title} · ${topic.slice(0,16)}`;shot.intent=`围绕“${topic}”的${title}；离线演示提纲，不作为事实主张`;shot.composition=['标题与弧线','卡片与流程','收束与行动'][index]!;shot.action=['标题滑入','卡片淡入','图形缩放'][index]!;
    shot.params={...shot.params,text:text!,subtitle:subtitle!,accent:palette,background:['#101923','#1b1630','#142522'][index]!,motion:['slide','fade','zoom'][index] as Shot['params']['motion'],fontSize:68,demoStage:index};shot.narration='';
    shot.assetIds=project.assets.filter(a=>a.kind==='image').slice(0,1).map(a=>a.id);return shot;
  });return normalizeSceneDurations(shots,Math.max(shots.length,Math.round(project.targetDuration*(project.target.fps?.num/project.target.fps?.den||30))));
}
export function demoSceneSource(stage:number):SceneSource{
  const source=defaultSceneSource();source.css+='\n.vs-mark { width:96px; height:6px; } .vs-copy { z-index:2; }';
  source.js=source.js.replace('  g.restore();',`  g.restore();
  // Offline fixture, stage ${stage}; all animation is evaluated from local time.
  g.save();g.strokeStyle=String(p.accent);g.fillStyle=String(p.accent);g.globalAlpha=.12;
  const phase=Math.max(0,Math.min(1,ctx.progress));const stage=Number(p.demoStage??${stage});
  if(stage===0){for(let i=0;i<4;i++){g.beginPath();g.arc(w*.80,h*.51,w*(.09+i*.047+phase*.008),0,Math.PI*2);g.lineWidth=2;g.stroke();}}
  else if(stage===1){for(let i=0;i<3;i++){const x=w*.64+i*w*.055;const y=h*(.30+i*.14);g.fillRect(x,y,w*.19,h*.09);}}
  else{g.translate(w*.80,h*.50);g.rotate(phase*.3);g.lineWidth=3;g.strokeRect(-w*.11,-w*.11,w*.22,w*.22);g.strokeRect(-w*.07,-w*.07,w*.14,w*.14);}
  g.restore();`);return source;
}
