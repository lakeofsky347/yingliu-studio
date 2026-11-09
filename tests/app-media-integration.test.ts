import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {randomUUID} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApplication, MemorySecrets } from '../src/app/application.ts';
import { defaultSceneSource } from '../src/core/index.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import type { ProviderConnection, ModelDefinition } from '../src/models/contracts.ts';
import type { MediaTask } from '../src/jobs/contracts.ts';
import type { WorkflowRecord } from '../src/workflows/contracts.ts';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function speechWav(){const bytes=Buffer.alloc(44+48000);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;}
async function fixture(options:{blockSpeech?:boolean}={}){
  let calls=0,speechCalls=0,releaseSpeech=()=>{};
  const speechGate=options.blockSpeech?new Promise<void>(resolve=>{releaseSpeech=resolve;}):Promise.resolve();
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/audio/speech'){speechCalls++;await speechGate;res.setHeader('Content-Type','audio/wav');res.end(speechWav());return;}
    if(req.url==='/v1/images/generations'){res.end(JSON.stringify({data:[{b64_json:png}]}));return;}
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'director-test'}]}));return;}
    if(req.url==='/v1/chat/completions'){
      calls++;const prompt=body.messages.at(-1).content;
      const context=JSON.parse(typeof prompt==='string'?prompt:prompt[0].text);
      const output=body.messages[0].content.includes('director')?{shots:context.shots.map((shot:{id:string})=>({shotId:shot.id,prompt:'中文测试画面',narration:'测试旁白'}))}:defaultSceneSource();
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise<void>(accept=>server.listen(0,'127.0.0.1',accept));const address=server.address() as {port:number};
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-media-'));
  const app=await createApplication({dataDirectory:directory,credentials:new MemorySecrets()});
  const sessions=new Map<string,string>(),writes=new Set(['create','save','media.generate','media.apply','workflows.run']);const call=async<T>(endpoint:string,payload:unknown={}):Promise<T>=>{let data={...(payload as Record<string,unknown>)};if(writes.has(endpoint))data={...data,operationId:randomUUID(),...(endpoint==='create'?{expectedRevision:null,target:{width:320,height:180,fps:{num:12,den:1}}}:{})};if(endpoint==='workflows.run'){const projectId=String(data.projectId);let sessionId=sessions.get(projectId);if(!sessionId){const session=await app.route('sessions.create',{projectId});if(!session.ok)throw new Error(session.error.message);sessionId=(session.value as {id:string}).id;sessions.set(projectId,sessionId);}data.sessionId=sessionId;}const value=await app.route(endpoint,data);if(!value.ok)throw Object.assign(new Error(value.error.message),{code:value.error.code});return value.value as T;};
  return {app,call,baseUrl:`http://127.0.0.1:${address.port}/v1`,get calls(){return calls;},get speechCalls(){return speechCalls;},releaseSpeech,async close(){releaseSpeech();await app.dispose();server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));await rm(directory,{recursive:true,force:true});}};
}
async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{const end=Date.now()+90000;while(true){const value=await read();if(done(value))return value;if(Date.now()>end)throw new Error('测试等待超时');await new Promise(accept=>setTimeout(accept,20));}}

test('application model routes return editable entities; generated media uses CAS and preserves user edits',async()=>{
  const f=await fixture();try{
    const connection=await f.call<ProviderConnection>('models.connection.save',{name:'本地图片测试',protocol:'images',baseUrl:f.baseUrl,auth:'none'});assert.ok(connection.id);
    const model=await f.call<ModelDefinition>('models.model.save',{connectionId:connection.id,model:'image-test',name:'图片',inputModalities:['text'],outputModalities:['image'],parameters:{}});assert.ok(model.id);
    await f.call('models.role.bind',{role:'image',modelId:model.id});
    const created=await f.call<StudioSnapshot>('create',{title:'媒体事务'}),project=created.project!;
    const task=await f.call<MediaTask>('media.generate',{projectId:project.id,shotId:project.shots[0]!.id,expectedRevision:project.revision,operation:'text-to-image',prompt:'蓝色背景'});
    const ready=await until(()=>f.call<MediaTask>('media.get',{taskId:task.id}),value=>['ready','failed'].includes(value.phase));assert.equal(ready.phase,'ready',ready.error);
    const saved=await f.call<StudioSnapshot>('save',{projectId:project.id,expectedRevision:project.revision,project:{...project,title:'用户最新标题'}});
    await assert.rejects(f.call('media.apply',{taskId:task.id,expectedRevision:project.revision}),/版本/);
    const applied=await f.call<MediaTask>('media.apply',{taskId:task.id,expectedRevision:saved.project!.revision});assert.equal(applied.phase,'complete');
    const current=await f.call<StudioSnapshot>('current',{projectId:project.id});assert.equal(current.project!.title,'用户最新标题');assert.equal(current.project!.assets.length,1);assert.ok(current.project!.shots[0]!.assetIds.includes(applied.applied!.assetIds[0]!));
    const repeated=await f.call<MediaTask>('media.apply',{taskId:task.id,expectedRevision:current.project!.revision});assert.equal(repeated.applied!.revision,applied.applied!.revision);
  }finally{await f.close();}
});

test('application workflow invokes configured director and scene roles, then commits candidates once',async()=>{
  const f=await fixture();try{
    const connection=await f.call<ProviderConnection>('models.connection.save',{name:'本地文本测试',protocol:'chat-completions',baseUrl:f.baseUrl,auth:'none'});
    const model=await f.call<ModelDefinition>('models.model.save',{connectionId:connection.id,model:'director-test',inputModalities:['text'],outputModalities:['text'],parameters:{}});
    for(const role of ['director','scene'])await f.call('models.role.bind',{role,modelId:model.id});
    const project=(await f.call<StudioSnapshot>('create',{title:'工作流'})).project!;
    const started=await f.call<WorkflowRecord>('workflows.run',{projectId:project.id,expectedRevision:project.revision,prompt:'制作三个清楚的镜头',visual:'code',narration:false,review:false,allowImageUpload:false,maxTasks:12});
    const complete=await until(()=>f.call<WorkflowRecord>('workflows.get',{workflowId:started.id}),value=>value.status!=='running');assert.equal(complete.status,'complete',complete.error);assert.equal(complete.committedRevision,project.revision+1);assert.equal(f.calls,project.shots.length+1);
    const current=(await f.call<StudioSnapshot>('current',{projectId:project.id})).project!;assert.deepEqual(current.shots.map(shot=>shot.id),project.shots.map(shot=>shot.id));assert.equal(current.revision,project.revision+1);
    await f.call('workflows.retry',{workflowId:started.id});assert.equal((await f.call<StudioSnapshot>('current',{projectId:project.id})).project!.revision,current.revision);
  }finally{await f.close();}
});

test('application workflow blocks a changed frozen speech route and a new task uses corrected configuration',{skip:spawnSync('ffprobe',['-version']).status!==0},async()=>{
  const f=await fixture();try{
    const text=await f.call<ProviderConnection>('models.connection.save',{protocol:'chat-completions',baseUrl:f.baseUrl,auth:'none'}),model=await f.call<ModelDefinition>('models.model.save',{connectionId:text.id,model:'director-test'});
    for(const role of ['director','scene'])await f.call('models.role.bind',{role,modelId:model.id});
    const speech=await f.call<ProviderConnection>('models.connection.save',{protocol:'speech',baseUrl:f.baseUrl,auth:'bearer',enabled:false}),voice=await f.call<ModelDefinition>('models.model.save',{connectionId:speech.id,model:'speech-test',parameters:{voice:'fixture'}});
    await f.call('models.role.bind',{role:'speech',modelId:voice.id});const project=(await f.call<StudioSnapshot>('create',{title:'配音配置冻结'})).project!;
    const request={projectId:project.id,expectedRevision:project.revision,shotIds:[project.shots[0]!.id],prompt:'制作并配音',visual:'code',narration:true,review:false,allowImageUpload:false};
    const run=await f.call<WorkflowRecord>('workflows.run',request),stopped=await until(()=>f.call<WorkflowRecord>('workflows.get',{workflowId:run.id}),value=>value.status!=='running');assert.equal(stopped.status,'failed');assert.equal(f.speechCalls,0);const textCalls=f.calls;
    await f.call('models.connection.save',{id:speech.id,enabled:true,apiKey:'local-speech-fixture-key'});await f.call('workflows.retry',{workflowId:run.id});const blocked=await until(()=>f.call<WorkflowRecord>('workflows.get',{workflowId:run.id}),value=>value.status!=='running');assert.equal(blocked.phase,'blocked');assert.match(blocked.error??'',/冻结快照/);assert.equal(f.calls,textCalls);assert.equal(f.speechCalls,0);
    const fresh=await f.call<WorkflowRecord>('workflows.run',request),done=await until(()=>f.call<WorkflowRecord>('workflows.get',{workflowId:fresh.id}),value=>value.status!=='running');assert.equal(done.status,'complete',done.error);assert.equal(f.speechCalls,1);
    const current=(await f.call<StudioSnapshot>('current',{projectId:project.id})).project!;assert.equal(current.revision,project.revision+1);assert.equal(current.audioClips!.length,1);assert.equal(current.assets.find(asset=>asset.kind==='audio')!.mime,'audio/wav');
  }finally{await f.close();}
});

test('application speech lease protects model connection until the request and media import finish',{skip:spawnSync('ffprobe',['-version']).status!==0},async()=>{
  const f=await fixture({blockSpeech:true});try{
    const text=await f.call<ProviderConnection>('models.connection.save',{protocol:'chat-completions',baseUrl:f.baseUrl,auth:'none'}),model=await f.call<ModelDefinition>('models.model.save',{connectionId:text.id,model:'director-test'});
    for(const role of ['director','scene'])await f.call('models.role.bind',{role,modelId:model.id});
    const speech=await f.call<ProviderConnection>('models.connection.save',{protocol:'speech',baseUrl:f.baseUrl,auth:'none'}),voice=await f.call<ModelDefinition>('models.model.save',{connectionId:speech.id,model:'speech-test',parameters:{voice:'fixture'}});await f.call('models.role.bind',{role:'speech',modelId:voice.id});
    const project=(await f.call<StudioSnapshot>('create',{title:'配音连接占用'})).project!;
    const run=await f.call<WorkflowRecord>('workflows.run',{projectId:project.id,expectedRevision:project.revision,shotIds:[project.shots[0]!.id],prompt:'配音请求占用测试',visual:'code',narration:true,review:false,allowImageUpload:false});
    await until(async()=>f.speechCalls,value=>value===1);
    await assert.rejects(f.call('models.connection.save',{id:speech.id,baseUrl:f.baseUrl+'/changed'}),/任务使用/);
    await assert.rejects(f.call('models.model.remove',{id:voice.id}),/任务使用/);await assert.rejects(f.call('models.connection.remove',{id:speech.id}),/任务使用/);
    f.releaseSpeech();const done=await until(()=>f.call<WorkflowRecord>('workflows.get',{workflowId:run.id}),value=>value.status!=='running');assert.equal(done.status,'complete',done.error);
    await f.call('models.model.remove',{id:voice.id});await f.call('models.connection.remove',{id:speech.id});assert.equal(f.speechCalls,1);
  }finally{await f.close();}
});
