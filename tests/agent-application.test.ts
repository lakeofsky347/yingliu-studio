import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { createProject, defaultSceneSource } from '../src/core/index.ts';
import { detectEnvironment } from '../src/host/renderer.ts';
import type { AgentSession, AgentTask } from '../src/agent/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import type { Conversation } from '../src/app/contracts.ts';

test('public write protocol rejects missing identity and does not accept forged runtime credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'studio-protocol-')),app=await createApplication({dataDirectory:directory,credentials:new MemorySecrets()});
  try{
    for(const input of [{title:'无ID'},{title:'无版本',operationId:'missing-revision'},{title:'伪造',operationId:'spoof',expectedRevision:null,operation:{id:'x',taskId:'stolen'}}]){const result=await app.route('create',input);assert.equal(result.ok,false);if(!result.ok)assert.match(result.error.code,/PROTOCOL|IDENTITY/);}
    const projects=await app.backend.call<{projects:unknown[]}>('list');assert.equal(projects.projects.length,0);
    const created=await app.route('create',{title:'稳定请求',operationId:'stable-create',expectedRevision:null});assert.equal(created.ok,true);
    const replay=await app.route('create',{title:'稳定请求',operationId:'stable-create',expectedRevision:null});assert.equal(replay.ok,true);
    if(created.ok&&replay.ok)assert.equal((created.value as StudioSnapshot).project!.id,(replay.value as StudioSnapshot).project!.id);
    const changed=await app.route('create',{title:'另一参数',operationId:'stable-create',expectedRevision:null});assert.equal(changed.ok,false);
  }finally{await app.dispose();await rm(directory,{recursive:true,force:true});}
});

test('localhost director delegates a real isolated scene loop, accepts a validated candidate and commits once',async t=>{
  if(!(await detectEnvironment()).browserAvailable){t.skip('需要 Chromium 才能完成真实候选验证');return;}
  const directory=await mkdtemp(join(tmpdir(),'studio-team-app-')),prompts:{model:string;messages:any[]}[]=[];
  let sceneCalls=0,serverError:unknown;
  const server=createServer(async(req,res)=>{try{
    const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const body=JSON.parse(Buffer.concat(parts).toString());prompts.push({model:body.model,messages:body.messages});let output:unknown;
    if(body.model==='team-scene'){
      const context=JSON.parse(body.messages.find((item:any)=>item.role==='user').content),shotId=context.scope.shotIds[0];
      output=++sceneCalls===1?{type:'execute',tool:'code',shotId,input:{source:{...defaultSceneSource(),html:defaultSceneSource().html+'<span data-member-result="accepted">成员候选标记</span>'}}}:{type:'submit',summary:'已生成授权镜头源码，等待实际浏览器验收'};
    }else{
      const last=body.messages.filter((item:any)=>item.role==='user').at(-1).content,context=JSON.parse(last.replace(/^当前上下文：/,'')),receipts=context.receipts??[],latest=receipts.at(-1);
      if(!latest)output={intent:'modify',done:false,message:'委派单镜头制作',actions:[{tool:'agent_delegate',arguments:{goal:'只修改第一镜源码',role:'scene',mode:'subagent',shotIds:[context.selectedShotIds[0]]}}]};
      else if(latest.tool==='agent_delegate')output={intent:'modify',done:false,message:'等待真实成员产物',actions:[{tool:'agent_wait',arguments:{taskId:latest.result.id}}]};
      else if(latest.tool==='agent_wait'){assert.equal(latest.result.status,'awaiting-acceptance',JSON.stringify(latest.result));output={intent:'modify',done:false,message:'采用已验证产物',actions:[{tool:'agent_accept',arguments:{candidateId:latest.result.candidateId}}]};}
      else if(latest.tool==='agent_accept')output={intent:'modify',done:true,message:'成员产物已采用并申请最终验证',actions:[]};
      else throw new Error(JSON.stringify(latest));
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));
  }catch(error){serverError=error;res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const app=await createApplication({dataDirectory:directory,credentials:new MemorySecrets()});
  const call=async<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>=>{const response=await app.route(endpoint,payload);if(!response.ok)throw Object.assign(new Error(response.error.message),{code:response.error.code});return response.value as T;};
  try{
    const connection=await call<{id:string}>('models.connection.save',{name:'localhost fixture',protocol:'chat-completions',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,auth:'none',concurrency:2});
    for(const role of ['director','scene'] as const){const model=await call<{id:string}>('models.model.save',{connectionId:connection.id,model:'team-'+role,name:role,inputModalities:['text'],outputModalities:['text'],parameters:{contextCharLimit:24000}});await call('models.role.bind',{role,modelId:model.id});}
    const project=createProject('协作实际链路','范围隔离');project.target={width:160,height:90,fps:{num:12,den:1},audioMode:'none'};project.targetDuration=1.5;project.shots.forEach(shot=>shot.durationFrames=6);
    const created=await call('create',{operationId:'initial-project',expectedRevision:null,project}),projectId=created.project!.id,session=await call<AgentSession>('sessions.create',{projectId});
    const request={sessionId:session.id,operationId:randomUUID(),expectedRevision:0,projectId,message:'请委派成员修改第一镜源码，其余镜头保持原样',shotId:project.shots[0]!.id,intent:'modify',provider:connection.id,model:'team-director'};
    const result=await call<{conversation:Conversation;snapshot:StudioSnapshot}>('chat.send',request);
    assert.equal(serverError,undefined);assert.equal(result.snapshot.project!.revision,1);assert.equal(result.conversation.turns!.at(-1)!.status,'succeeded');assert.equal(sceneCalls,2);
    const tasks=await call<{tasks:AgentTask[]}>('agent.tasks',{projectId,sessionId:session.id});assert.equal(tasks.tasks.length,2);assert.ok(tasks.tasks.every(task=>task.status==='succeeded'));assert.ok(tasks.tasks.every(task=>task.leaseOwner===undefined));
    assert.match((await call<{html:string}>('source',{projectId,shotId:project.shots[0]!.id})).html,/data-member-result/);
    const rootRequests=prompts.filter(prompt=>prompt.model==='team-director');assert.equal(rootRequests.length,4);assert.ok(rootRequests.every(prompt=>!JSON.stringify(prompt.messages).includes('data-member-result')),'成员源码通过产物引用交接，不进入主管提示');
    const replay=await call<{snapshot:StudioSnapshot}>('chat.send',request);assert.equal(replay.snapshot.project!.revision,1);assert.equal(prompts.length,6);
  }finally{await app.dispose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
