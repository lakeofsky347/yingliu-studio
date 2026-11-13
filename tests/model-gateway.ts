import { defaultSceneSource } from '../src/core/index.ts';
import { demoPatch } from '../src/app/conversation.ts';
import type { VideoProject } from '../src/shared/types.ts';

/** Test-only HTTP body responder. It exercises production custom mode without a paid provider. */
export function mockDirectorResponse(body:unknown):Record<string,unknown>{
  const messages=(body as {messages?:{role:string;content:unknown}[]}).messages??[];
  const last=[...messages].reverse().find(message=>message.role==='user'&&(typeof message.content==='string'?message.content:JSON.stringify(message.content)).includes('当前上下文：'));
  const raw=typeof last?.content==='string'?last.content:(last?.content as {type:string;text?:string}[]|undefined)?.find(block=>block.type==='text')?.text??'';
  const context=JSON.parse(raw.slice(raw.indexOf('当前上下文：')+'当前上下文：'.length)) as {project:VideoProject|null;request:string;requestedIntent:string;selectedShotIds:string[]};
  if(['chat','discuss'].includes(context.requestedIntent))return {intent:context.requestedIntent,message:'可以先讨论叙事目标和视觉方案，确定后再开始制作。',done:true,actions:[]};
  const project=context.project;
  if(!project||!project.shots.length){const topic=context.request.replace(/^(?:请|帮我|做一个|制作|关于)\s*/g,'').slice(0,48);return {intent:'create',message:'已规划可编辑的视频初稿。',done:true,actions:[{tool:'video_update',arguments:{expectedRevision:project?.revision??0,update:{storyboard:{shots:[0,1,2].map(index=>({title:['开场','展开','收束'][index],intent:'围绕主题叙述',composition:'标题与主体分层',action:'按帧进入',durationSeconds:6,params:{text:index===0?topic:`${topic} · ${index===1?'展开':'下一步'}`,subtitle:'本地 mock 网关测试内容',motion:'fade'}}))},sourcesByIndex:[defaultSceneSource(),defaultSceneSource(),defaultSceneSource()]}}}]};}
  const selected=project.shots.filter(shot=>context.selectedShotIds.includes(shot.id));const shots=selected.length?selected:[project.shots.find(shot=>shot.id===project.shotOrder[0])!];
  return {intent:'modify',message:'已按请求规划局部修改。',done:true,actions:[{tool:'video_update',arguments:{expectedRevision:project.revision,update:{shotPatches:shots.map(shot=>({id:shot.id,patch:demoPatch(shot,context.request,project.target.fps.num/project.target.fps.den)}))}}}]};
}
export function mockCompletionBody(body:unknown){return {choices:[{message:{role:'assistant',content:JSON.stringify(mockDirectorResponse(body))},finish_reason:'stop'}]};}

/** Test-only scripted chat-completions gateway that can answer with native tool_calls (no paid provider). */
export type GatewayReply = {toolCalls?:{name:string;arguments:unknown;id?:string}[];text?:string;status?:number;error?:string;usage?:{prompt_tokens:number;completion_tokens:number}};
export function toolGateway(script:(body:Record<string,any>,turn:number)=>GatewayReply){
  const requests:Record<string,any>[]=[];let turn=0;
  const realFetch=globalThis.fetch;
  const gatewayFetch=(async(_url:unknown,init?:{body?:unknown})=>{
    if(!String(_url).includes('gateway.test'))return realFetch(_url as string,init as RequestInit);
    const body=JSON.parse(String(init?.body??'{}'));requests.push(body);const reply=script(body,turn++);
    if(reply.status&&reply.status>=400)return new Response(reply.error??'error',{status:reply.status});
    const calls=reply.toolCalls?.map((call,index)=>({id:call.id??`call_${turn}_${index}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:reply.text??null,...(calls?.length?{tool_calls:calls}:{})},finish_reason:calls?.length?'tool_calls':'stop'}],usage:reply.usage??{prompt_tokens:100,completion_tokens:20}}),{headers:{'content-type':'application/json'}});
  }) as unknown as typeof fetch;
  return {fetch:gatewayFetch,requests,reset(){turn=0;}};
}
