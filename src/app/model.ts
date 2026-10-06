import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSceneSource, defaultShot, normalizeSceneDurations } from '../core/index.ts';
import type { SceneSource, Shot, VideoProject } from '../shared/types.ts';
import type { ProviderConfig, ProviderHost, ProviderSettings, SecretStore } from './contracts.ts';

export const DEMO_PROVIDER = 'demo';
export const DEMO_MODEL = 'offline-director';
const KEY_REF = 'yingliu.custom-model.api-key';
const DEFAULT:ProviderConfig={id:'custom',name:'DeepSeek / 兼容接口',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat',supportsVision:false};
type ChatTurn={role:'system'|'user'|'assistant';content:string};
type StreamOptions=Parameters<ProviderHost['stream']>[0];

function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function configuration(value:Partial<ProviderConfig>):ProviderConfig{
  const config={...DEFAULT,...value,id:'custom'};
  config.name=String(config.name).trim()||DEFAULT.name;config.model=String(config.model).trim();
  const url=new URL(String(config.baseUrl));
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('模型地址须为无凭据、查询参数或片段的 HTTP(S) 地址');
  config.baseUrl=url.href.replace(/\/$/,'');config.supportsVision=!!config.supportsVision;
  if(!config.model||config.model.length>200)throw new Error('请填写有效模型名称');
  return config;
}
function turns(messages:unknown[]):ChatTurn[]{
  return messages.map(message=>{
    const item=object(message);const role=item.role==='assistant'?'assistant':item.role==='system'?'system':'user';
    const content=typeof item.content==='string'?item.content:Array.isArray(item.content)?item.content.map(block=>{const part=object(block);return typeof part.text==='string'?part.text:part.type==='image'?'[图片附件：当前路径只传入文字资产说明，未将图片像素发送给模型]':'';}).filter(Boolean).join('\n'):JSON.stringify(item.content??'');
    return {role,content};
  });
}
function finishReason(reason:unknown){return reason==='stop'?{kind:'stop'}:reason==='length'?{kind:'max-tokens'}:{kind:'failure',failure:{message:`模型未正常结束：${String(reason??'缺少完成原因')}`}};}

/** Configuration is local to this app; only the injected SecretStore handles the key. */
export class ProviderManager {
  private config:ProviderConfig={...DEFAULT};private mode:'demo'|'custom'='demo';private initialized?:Promise<void>;
  constructor(private dataDirectory:string,private secrets:SecretStore){}
  initialize():Promise<void>{return this.initialized??=(async()=>{
    try{const saved=object(JSON.parse(await readFile(join(this.dataDirectory,'provider.json'),'utf8')));this.config=configuration(object(saved.config));this.mode=saved.mode==='custom'?'custom':'demo';}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  })();}
  async settings():Promise<ProviderSettings>{await this.initialize();return {config:structuredClone(this.config),hasKey:!!(await this.secrets.get(KEY_REF)),mode:this.mode};}
  async save(input:Partial<ProviderConfig>&{apiKey?:string;mode?:'demo'|'custom'}):Promise<ProviderSettings>{
    await this.initialize();const {apiKey,mode,...fields}=input;const next=configuration({...this.config,...fields});
    if(mode!==undefined&&!['demo','custom'].includes(mode))throw new Error('模型模式无效');
    if(apiKey!==undefined){if(apiKey.trim())await this.secrets.set(KEY_REF,apiKey.trim());else await this.secrets.delete(KEY_REF);}
    const nextMode=mode??this.mode;await mkdir(this.dataDirectory,{recursive:true});
    const path=join(this.dataDirectory,'provider.json');await writeFile(path+'.tmp',JSON.stringify({version:1,config:next,mode:nextMode},null,2)+'\n');await rename(path+'.tmp',path);
    this.config=next;this.mode=nextMode;return this.settings();
  }
  async check():Promise<{ok:boolean;message:string}>{
    const settings=await this.settings();if(settings.mode==='demo')return {ok:true,message:'离线演示模型可用；这是确定性演示，未连接远程模型。'};
    const key=await this.secrets.get(KEY_REF);if(!key)return {ok:false,message:'请先保存当前应用的模型 API Key。'};
    try{const response=await fetch(this.config.baseUrl+'/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok)return {ok:false,message:`模型目录检查失败（HTTP ${response.status}）；真实创作仍为 NOT_CHECKED。`};
      const value=object(await response.json()),models=Array.isArray(value.data)?value.data.map(x=>object(x).id):[];
      return models.includes(this.config.model)?{ok:true,message:'服务可访问，所选模型在目录中；此检查未执行真实创作，真实创作为 NOT_CHECKED。'}:{ok:true,message:'服务可访问；模型目录未确认所选名称，真实创作为 NOT_CHECKED。'};
    }catch(error){return {ok:false,message:`连接检查失败：${(error instanceof Error?error.message:'未知错误').split(key).join('[redacted]')}`};}
  }
  host():ProviderHost{return {
    listProviders:()=>[{id:DEMO_PROVIDER,name:'离线演示模型'},{id:'custom',name:this.config.name}],
    listModels:async id=>{await this.initialize();if(id===DEMO_PROVIDER)return [{id:DEMO_MODEL,name:'离线导演 · 确定性演示',inputModalities:['text']}];if(id==='custom')return [{id:this.config.model,name:this.config.model,inputModalities:['text']}];throw new Error('未知模型供应商');},
    resolveModelInfo:async(id,model,signal)=>{signal?.throwIfAborted();if(id!==DEMO_PROVIDER&&id!=='custom'||model!==(id===DEMO_PROVIDER?DEMO_MODEL:this.config.model))throw new Error('模型已变更，请重新选择');return {inputModalities:['text']};},
    stream:options=>this.stream(options),
  };}
  /** Full multi-turn text request, used by the app director. No PNG pixels are implied. */
  async complete(messages:ChatTurn[],system:string,signal:AbortSignal,maxTokens=6000):Promise<string>{
    await this.initialize();let result='',stopped=false;
    for await(const chunk of this.stream({provider:'custom',model:this.config.model,messages,system,maxTokens,sessionId:'app-director',signal})){
      if(chunk.type==='text-delta')result+=chunk.text??'';
      if(chunk.type==='finish'){if(chunk.reason?.kind!=='stop')throw new Error(chunk.reason?.failure?.message??'模型输出不完整，请缩小修改范围');stopped=true;}
    }
    if(!stopped||!result.trim())throw new Error('模型没有返回完整文本');return result;
  }
  private async *stream(options:StreamOptions):ReturnType<ProviderHost['stream']>{
    await this.initialize();options.signal.throwIfAborted();
    if(options.provider===DEMO_PROVIDER){
      if(options.model!==DEMO_MODEL)throw new Error('离线演示模型名称无效');
      const last=turns(options.messages).at(-1)?.content??'{}';let input:Record<string,unknown>;
      try{input=object(JSON.parse(last));}catch{throw new Error('离线演示只支持视频导演的结构化请求');}
      const project={topic:String(input.topic??object(input.video).topic??''),targetDuration:Number(input.durationSeconds??object(input.video).durationSeconds??18),target:object(input.target??object(input.video).target),assets:input.assets??[]} as unknown as VideoProject;
      const value=input.task==='storyboard'?{shots:demoStoryboard(project).map(s=>({...s,durationSeconds:s.durationFrames/(project.target.fps?.num/project.target.fps?.den||30)}))}:{...demoSceneSource(Number(object(input.shot).params&&object(object(input.shot).params).demoStage||0))};
      yield {type:'text-delta',text:JSON.stringify(value)};yield {type:'finish',reason:{kind:'stop'}};return;
    }
    if(options.provider!=='custom'||options.model!==this.config.model)throw new Error('请选择当前应用已配置的模型');
    const key=await this.secrets.get(KEY_REF);if(!key)throw new Error('当前应用未配置模型 API Key；可先使用离线演示模型');
    const signal=AbortSignal.any([options.signal,AbortSignal.timeout(90000)]);
    try{
    const response=await fetch(this.config.baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},signal,
      body:JSON.stringify({model:this.config.model,messages:[{role:'system',content:options.system},...turns(options.messages)],max_tokens:Math.max(128,Math.min(8192,options.maxTokens)),stream:true})});
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
