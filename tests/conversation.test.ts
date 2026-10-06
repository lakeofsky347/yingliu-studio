import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, updateShot } from '../src/core/index.ts';
import type { StudioSnapshot, RpcResult } from '../src/shared/types.ts';
import type { BackendPort, SecretStore } from '../src/app/contracts.ts';
import { ConversationService } from '../src/app/conversation.ts';
import { DEMO_MODEL, ProviderManager } from '../src/app/model.ts';

class MemorySecrets implements SecretStore {async get(){return undefined;}async set(){}async delete(){}}
class FixtureBackend implements BackendPort {
  state:StudioSnapshot={project:null,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'fixture',ffmpegPath:'fixture',ffprobePath:'fixture',browserAvailable:true,ffmpegAvailable:true,ffprobeAvailable:true}};
  calls:{endpoint:string;payload:Record<string,any>}[]=[];sources=new Map<string,unknown>();holdPreview=false;
  async call<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>{const data=payload as Record<string,any>;this.calls.push({endpoint,payload:data});
    if(endpoint==='create'){this.state.project=createProject(data.title,data.topic);this.state.project.targetDuration=data.targetDuration;this.state.root='/fixture';}
    if(endpoint==='apply'){const project=this.state.project!;assert.equal(data.expectedRevision,project.revision,'compare-and-swap revision is always provided');if(data.title)project.title=data.title;if(data.topic)project.topic=data.topic;if(data.shots){project.shots=data.shots;project.shotOrder=data.shots.map((shot:any)=>shot.id);}for(const patch of data.shotPatches??[])this.state.project=updateShot(this.state.project!,patch.id,patch.patch);for(const item of data.sources??[])this.sources.set(item.shotId,item.source);this.state.project!.revision++;}
    if(endpoint==='preview'){this.state.previewUrl='http://fixture.test/preview';this.state.previewRevision=this.state.project!.revision;this.state.task={id:'fixture-preview',kind:'preview',status:this.holdPreview?'running':'complete',progress:1,message:'fixture metadata check',startedAt:new Date().toISOString()};}
    if(endpoint==='cancel'&&this.state.task)this.state.task.status='cancelled';
    if(endpoint==='inspect')return {projectId:this.state.project!.id,revision:this.state.project!.revision,spec:{diagnostic:'metadata only'}} as T;
    return structuredClone(this.state) as T;
  }
  async route(endpoint:string,payload:unknown):Promise<RpcResult>{return {ok:true,value:await this.call(endpoint,payload)};}
}

test('first offline conversation creates saved three-scene draft and checks preview',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-chat-'));
  try{const backend=new FixtureBackend(),providers=new ProviderManager(directory,new MemorySecrets()),service=new ConversationService(backend,providers,directory);
    const result=await service.send({message:'做一个关于海边散步的短片',provider:'demo',model:DEMO_MODEL});assert.equal(result.snapshot.project?.shots.length,3);assert.equal(result.snapshot.project?.topic,'海边散步');assert.equal(backend.sources.size,3);assert.equal(result.snapshot.previewRevision,result.snapshot.project!.revision);assert.match(result.conversation.messages.at(-1)!.content,/确定性演示/);assert.match(result.conversation.messages.at(-1)!.content,/不代表模型视觉检查/);
    const restored=await new ConversationService(backend,providers,directory).history(result.snapshot.project!.id);assert.equal(restored.messages.length,2);assert.equal(restored.projectId,result.snapshot.project!.id);assert.ok(backend.calls.some(c=>c.endpoint==='inspect'));assert.ok(!backend.calls.some(c=>c.endpoint==='generate'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('chat fills an existing empty project while preserving its ID and manual title',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-empty-chat-'));
  try{const backend=new FixtureBackend();backend.state.project=createProject('我的手动工程','');backend.state.project.shots=[];backend.state.project.shotOrder=[];const id=backend.state.project.id;
    const service=new ConversationService(backend,new ProviderManager(directory,new MemorySecrets()),directory);const result=await service.send({message:'请帮我做一个关于雨夜城市的短片',projectId:id,provider:'demo',model:DEMO_MODEL});
    assert.equal(result.snapshot.project!.id,id);assert.equal(result.snapshot.project!.title,'我的手动工程');assert.equal(result.snapshot.project!.topic,'雨夜城市');assert.equal(result.snapshot.project!.shots.length,3);assert.ok(!backend.calls.some(call=>call.endpoint==='create'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a manual title survives second-shot motion edit; only requested stable ID changes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-local-edit-'));
  try{const backend=new FixtureBackend(),service=new ConversationService(backend,new ProviderManager(directory,new MemorySecrets()),directory);await service.send({message:'猫的午后',provider:'demo',model:DEMO_MODEL});
    const project=backend.state.project!,ids=[...project.shotOrder];project.shots[1]!.title='用户手改标题';const before=structuredClone(project.shots[0]);
    const result=await service.send({message:'第二镜运动改成滑入，时长 8 秒',projectId:project.id,shotId:ids[0],provider:'demo',model:DEMO_MODEL});
    const changed=result.snapshot.project!.shots[1]!;assert.equal(changed.id,ids[1]);assert.equal(changed.title,'用户手改标题');assert.equal(changed.params.motion,'slide');assert.equal(changed.durationFrames,240);assert.deepEqual(result.snapshot.project!.shots[0],before);
    await service.send({message:'第三镜标题改为下一步',projectId:project.id,provider:'demo',model:DEMO_MODEL});assert.equal(backend.state.project!.shots[2]!.title,'下一步');assert.equal(backend.state.project!.shots[1]!.title,'用户手改标题');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('cancel interrupts waiting draft task and persists explicit failed turn',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-cancel-'));
  try{const backend=new FixtureBackend();backend.holdPreview=true;const service=new ConversationService(backend,new ProviderManager(directory,new MemorySecrets()),directory);
    const pending=service.send({message:'森林里的光',provider:'demo',model:DEMO_MODEL});
    while(!backend.state.task)await new Promise(resolve=>setTimeout(resolve,5));service.cancel();await assert.rejects(pending,/取消/);const saved=await service.history(backend.state.project!.id);assert.match(saved.messages.at(-1)!.content,/制作未完成.*取消/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('custom structured director reads current graph edits, receives receipts and preserves manual title',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-custom-fixture-'));
  try{const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');const shot=backend.state.project.shots[1]!;shot.title='手改标题';const prompts:string[]=[];let round=0;
    class FixtureProvider extends ProviderManager {override async complete(turns:{role:'system'|'user'|'assistant';content:string}[]){prompts.push(JSON.stringify(turns));round++;return round===1?JSON.stringify({message:'读取当前工程',done:false,actions:[{tool:'video_project',arguments:{action:'get'}}]}):JSON.stringify({message:'只改颜色',done:true,actions:[{tool:'video_update',arguments:{expectedRevision:backend.state.project!.revision,update:{shotPatches:[{id:shot.id,patch:{title:'模型覆盖标题',params:{background:'#112233'}}}]}}}]});}}
    const service=new ConversationService(backend,new FixtureProvider(directory,new MemorySecrets()),directory);const result=await service.send({message:'第二镜背景改成 #112233',projectId:backend.state.project.id,provider:'custom',model:'deepseek-chat'});
    assert.equal(result.snapshot.project!.shots[1]!.title,'手改标题');assert.equal(result.snapshot.project!.shots[1]!.params.background,'#112233');assert.equal(round,2);assert.match(prompts[1]!,/实际工具回执/);assert.match(prompts[0]!,/手改标题/);assert.match(prompts[0]!,/metadata-only/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
