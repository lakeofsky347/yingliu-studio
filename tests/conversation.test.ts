import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, defaultSceneSource, updateShot } from '../src/core/index.ts';
import type { StudioSnapshot, RpcResult, VideoProject } from '../src/shared/types.ts';
import type { BackendPort, ChatInput, SecretStore } from '../src/app/contracts.ts';
import { authorizedImages, compileDirectorPlan, ConversationService } from '../src/app/conversation.ts';
import { ProviderManager, type ModelMessage } from '../src/app/model.ts';
import { createFileSymlinkOrSkip } from './fixtures/symlink.ts';

class MemorySecrets implements SecretStore {values=new Map<string,string>();async get(ref:string){return this.values.get(ref);}async set(ref:string,value:string){this.values.set(ref,value);}async delete(ref:string){this.values.delete(ref);}}
class FixtureBackend implements BackendPort {
  state:StudioSnapshot={project:null,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'fixture',ffmpegPath:'fixture',ffprobePath:'fixture',browserAvailable:true,ffmpegAvailable:true,ffprobeAvailable:true}};
  calls:{endpoint:string;payload:Record<string,any>}[]=[];sources=new Map<string,unknown>();holdPreview=false;failPreview=false;failApply=false;conflictOnce=false;
  async call<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>{const data=payload as Record<string,any>;this.calls.push({endpoint,payload:data});
    if(endpoint==='create'){this.state.project=structuredClone(data.project??createProject(data.title,data.topic));this.state.root='/fixture';for(const item of data.sources??[])this.sources.set(item.shotId,item.source);}
    if(endpoint==='apply'){const project=this.state.project!;assert.equal(data.expectedRevision,project.revision);if(this.conflictOnce){this.conflictOnce=false;project.revision++;project.shots[1]!.params.text='用户在模型运行期间手改';throw Object.assign(new Error('工程版本冲突：请读取最新工程'),{code:'REVISION_CONFLICT'});}if(this.failApply)throw new Error('模拟磁盘事务回滚');const revision=project.revision;if(data.project)this.state.project=structuredClone(data.project);if(data.shots){this.state.project!.shots=data.shots;this.state.project!.shotOrder=data.shots.map((shot:any)=>shot.id);}for(const patch of data.shotPatches??[])this.state.project=updateShot(this.state.project!,patch.id,patch.patch);for(const item of data.sources??[])this.sources.set(item.shotId,item.source);this.state.project!.revision=revision+1;}
    if(endpoint==='preview'){this.state.previewUrl='http://fixture.test/preview';this.state.previewRevision=this.state.project!.revision;this.state.task={id:'fixture-preview',kind:'preview',status:this.failPreview?'failed':this.holdPreview?'running':'complete',progress:1,message:this.failPreview?'运行错误':'fixture check',startedAt:new Date().toISOString()};}
    if(endpoint==='cancel'&&this.state.task)this.state.task.status='cancelled';
    if(endpoint==='inspect')return {projectId:this.state.project?.id,revision:this.state.project?.revision,source:defaultSceneSource(),spec:{diagnostic:'metadata only'}} as T;
    return structuredClone(this.state) as T;
  }
  async route(endpoint:string,payload:unknown):Promise<RpcResult>{return {ok:true,value:await this.call(endpoint,payload)};}
}
class MockProvider extends ProviderManager {
  prompts:ModelMessage[][]=[];systems:string[]=[];
  constructor(directory:string,private respond:(turns:ModelMessage[],round:number)=>unknown,private secretsValue=new MemorySecrets()){super(directory,secretsValue);}
  async ready(){await this.save({apiKey:'mock-only-not-a-paid-key'});return this;}
  override async complete(turns:ModelMessage[],system:string,signal:AbortSignal){signal.throwIfAborted();this.prompts.push(structuredClone(turns));this.systems.push(system);const value=this.respond(turns,this.prompts.length);return typeof value==='string'?value:JSON.stringify(value);}
}
const chat=(message:string,projectId?:string):ChatInput=>({message,projectId,provider:'custom',model:'deepseek-chat'});
function patchPlan(project:VideoProject,patch:Record<string,unknown>,id=project.shotOrder[1]){return {intent:'modify',done:true,message:'修改已规划',actions:[{tool:'video_update',arguments:{expectedRevision:project.revision,update:{shotPatches:[{id,patch}]}}}]};}
function firstPlan(count=1){return {intent:'create',done:true,message:'初稿已规划',actions:[{tool:'video_update',arguments:{expectedRevision:0,update:{storyboard:{shots:Array.from({length:count},(_,index)=>({title:'镜头 '+index,durationSeconds:5,params:{text:'主题 '+index}}))},sourcesByIndex:Array.from({length:count},()=>defaultSceneSource())}}}]};}

async function withDirectory(work:(directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'yingliu-chat-production-'));try{await work(directory);}finally{await rm(directory,{recursive:true,force:true});}}

test('missing app Key fails before reading or creating a project and leaves no active turn',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend(),service=new ConversationService(backend,new ProviderManager(directory,new MemorySecrets()),directory);
  await assert.rejects(service.send(chat('制作一个视频')),/API Key/);assert.equal(backend.calls.length,0);assert.equal(service.hasActiveTurn(),false);assert.equal((await service.history()).messages.length,0);
}));

test('chat and discussion keep an empty workspace and never start preview',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend(),provider=await new MockProvider(directory,(_turns,round)=>({intent:round===1?'chat':'discuss',message:round===1?'你好，可以先聊想法。':'可以讨论结构。',done:true,actions:[]})).ready(),service=new ConversationService(backend,provider,directory);
  const greeting=await service.send(chat('你好'));assert.equal(greeting.snapshot.project,null);await service.send(chat('先讨论怎么安排分镜'));
  assert.ok(!backend.calls.some(call=>['create','apply','preview'].includes(call.endpoint)));assert.equal((await service.history()).turns?.length,2);assert.equal(provider.prompts[1]!.filter(m=>m.role==='assistant').length,1);
}));

test('one-shot and twelve-shot drafts use atomic complete create, no fixed three-shot constraint',()=>withDirectory(async directory=>{
  for(const count of [1,12]){const backend=new FixtureBackend(),provider=await new MockProvider(join(directory,String(count)),()=>firstPlan(count)).ready(),service=new ConversationService(backend,provider,join(directory,String(count)));
    const result=await service.send(chat('制作一个30秒视频'));assert.equal(result.snapshot.project?.shots.length,count);assert.equal(backend.sources.size,count);assert.equal(backend.calls.filter(c=>c.endpoint==='create').length,1);assert.equal(backend.calls.filter(c=>c.endpoint==='apply').length,0);assert.equal(result.snapshot.project!.shots.reduce((n,s)=>n+s.durationFrames,0),900);assert.equal(result.conversation.turns?.[0]?.status,'succeeded');assert.match(result.conversation.messages.at(-1)!.content,/运行检查/);
  }
}));

test('all valid add/delete/reorder/material/target/source edits commit in one apply',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('手工工程','主题');const project=backend.state.project,[first,second,third]=project.shotOrder;project.shots[1]!.title='手改标题';project.assets.push({id:'text-asset',kind:'text',name:'说明',description:'',text:'用户素材'});
  const provider=await new MockProvider(directory,()=>({intent:'modify',done:true,message:'安排已规划',actions:[{tool:'video_update',arguments:{expectedRevision:0,update:{addShots:[{tempId:'new-ending',title:'新尾声',durationSeconds:4,source:defaultSceneSource()}],deleteShotIds:[first],shotOrder:[third,second,'new-ending'],shotPatches:[{id:second,patch:{title:'不应覆盖',params:{motion:'slide'},durationSeconds:8}}],assetBindings:[{shotId:second,assetId:'text-asset'}],target:{width:1080,height:1920},sources:[{shotId:second,source:defaultSceneSource()}],selectedShotId:second}}}]})).ready();
  const service=new ConversationService(backend,provider,directory),result=await service.send({...chat('添加尾声，删除第一镜，重排顺序，第二镜滑入并设8秒，改成竖屏',project.id),shotId:second});
  assert.equal(backend.calls.filter(c=>c.endpoint==='apply').length,1);assert.equal(result.snapshot.project!.shots[0]?.id===first,false);assert.equal(result.snapshot.project!.shotOrder[0],third);const edited=result.snapshot.project!.shots.find(s=>s.id===second)!;assert.equal(edited.title,'手改标题');assert.equal(edited.durationFrames,240);assert.equal(edited.params.motion,'slide');assert.ok(edited.assetIds.includes('text-asset'));assert.equal(result.snapshot.project!.target.height,1920);assert.equal(result.snapshot.project!.extensions.selectedShotId,second);
}));

test('late invalid action rejects the entire plan with no partial writes, then retry succeeds',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');const project=backend.state.project,before=structuredClone(project);let valid=false;
  const provider=await new MockProvider(directory,()=>valid?patchPlan(project,{params:{background:'#112233'}}):{...patchPlan(project,{params:{background:'#112233'}}),actions:[...patchPlan(project,{params:{background:'#112233'}}).actions,{tool:'video_update',arguments:{expectedRevision:0,update:{sources:[{shotId:'missing-shot',source:defaultSceneSource()}]}}}]}).ready();
  const service=new ConversationService(backend,provider,directory);await assert.rejects(service.send(chat('第二镜背景改成蓝色',project.id)),/源码引用|未选中的镜头/);assert.deepEqual(backend.state.project,before);assert.ok(!backend.calls.some(c=>c.endpoint==='apply'));const saved=await service.history(project.id),failed=saved.turns!.at(-1)!;assert.equal(failed.status,'failed');assert.equal(service.hasActiveTurn(),false);assert.equal(provider.prompts.length,4);assert.match(JSON.stringify(provider.prompts[1]),/计划未提交/);
  valid=true;const result=await service.send({...chat('',project.id),retryTurnId:failed.id});assert.equal(result.conversation.turns!.at(-1)!.retryOf,failed.id);assert.equal(result.snapshot.project!.shots[1]!.params.background,'#112233');
}));

test('invalid model JSON is repaired within bounded multi-turn context',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend(),provider=await new MockProvider(directory,(_turns,round)=>round===1?'not json':{intent:'chat',done:true,message:'已修复格式',actions:[]}).ready(),service=new ConversationService(backend,provider,directory);
  await service.send(chat('你好'));assert.equal(provider.prompts.length,2);assert.match(JSON.stringify(provider.prompts[1]),/格式或工具校验错误/);assert.equal(backend.state.project,null);
}));

test('a completed read plan actually reads source and returns its receipt before the final answer',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');const second=backend.state.project.shotOrder[1]!;
  const provider=await new MockProvider(directory,(_turns,round)=>round===1?{intent:'discuss',done:true,message:'先读取',actions:[{tool:'video_inspect',arguments:{shotId:second,includeSource:true}}]}:{intent:'discuss',done:true,message:'已依据真实源码解释第二镜。',actions:[]}).ready(),service=new ConversationService(backend,provider,directory);
  await service.send({...chat('只讨论第二镜代码的构成',backend.state.project.id),intent:'discuss'});assert.equal(provider.prompts.length,2);assert.equal(backend.calls.filter(call=>call.endpoint==='inspect').length,1);assert.match(JSON.stringify(provider.prompts[1]),/metadata only/);assert.ok(!backend.calls.some(call=>['create','apply','preview'].includes(call.endpoint)));
}));

test('initial storyboard moves output to the right while an existing manual layout remains intact',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('blank','topic');backend.state.project.shots=[];backend.state.project.shotOrder=[];backend.state.project.graph.positions={'film-output':[375,140]};const projectId=backend.state.project.id;
  const provider=await new MockProvider(directory,()=>firstPlan(3)).ready(),service=new ConversationService(backend,provider,directory);const result=await service.send({...chat('生成一个视频',projectId),intent:'create'});const project=result.snapshot.project!;const rightmost=Math.max(...project.shots.map(shot=>project.graph.positions[shot.id]![0]));assert.equal(project.graph.positions['film-output']![0],rightmost+370);
  project.graph.positions['film-output']=[65,780];const snapshot={...result.snapshot,project},prepared=compileDirectorPlan(patchPlan(project,{params:{motion:'slide'}}),snapshot,chat('第二镜滑入',project.id),'modify');assert.deepEqual(prepared.candidate!.graph.positions['film-output'],[65,780]);
}));

test('revision conflict returns actual rejection and merges latest manual content before retry',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');backend.conflictOnce=true;const provider=await new MockProvider(directory,()=>patchPlan(backend.state.project!,{params:{motion:'slide'}})).ready(),service=new ConversationService(backend,provider,directory);
  const result=await service.send(chat('第二镜运动改成滑入',backend.state.project.id));assert.equal(provider.prompts.length,2);assert.match(JSON.stringify(provider.prompts[1]),/后端事务拒绝/);assert.equal(result.snapshot.project!.shots[1]!.params.text,'用户在模型运行期间手改');assert.equal(result.snapshot.project!.revision,2);assert.equal(result.snapshot.project!.shots[1]!.params.motion,'slide');
}));

test('ambiguous transaction I/O failure is not automatically resubmitted',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');backend.failApply=true;const before=structuredClone(backend.state.project),provider=await new MockProvider(directory,()=>patchPlan(backend.state.project!,{params:{motion:'slide'}})).ready(),service=new ConversationService(backend,provider,directory);
  await assert.rejects(service.send(chat('第二镜运动改成滑入',before.id)),/磁盘事务回滚/);assert.equal(provider.prompts.length,1);assert.equal(backend.calls.filter(call=>call.endpoint==='apply').length,1);assert.deepEqual(backend.state.project,before);assert.equal((await service.history(before.id)).turns!.at(-1)!.status,'failed');
}));

test('manual selected title survives motion-only changes and out-of-scope patch is rejected',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('manual','topic');const project=backend.state.project;project.shots[1]!.title='用户手改';const second=project.shotOrder[1]!;
  const provider=await new MockProvider(directory,()=>patchPlan(project,{title:'模型标题',params:{motion:'slide'}},second)).ready(),service=new ConversationService(backend,provider,directory);
  const result=await service.send({...chat('第二镜运动改为滑入',project.id),shotId:project.shotOrder[0]});assert.equal(result.snapshot.project!.shots[1]!.title,'用户手改');assert.equal(result.snapshot.project!.shots[1]!.params.motion,'slide');
  assert.throws(()=>compileDirectorPlan(patchPlan(backend.state.project!,{params:{motion:'zoom'}},project.shotOrder[0]),backend.state,chat('第二镜推近',project.id),'modify'),/未选中的镜头/);
}));

test('preview failure preserves committed revision and exposes repairable failed turn',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.failPreview=true;const provider=await new MockProvider(directory,()=>firstPlan(2)).ready(),service=new ConversationService(backend,provider,directory);
  await assert.rejects(service.send(chat('制作一个视频')),/已保存.*需要修复或撤销/);assert.equal(backend.state.project!.shots.length,2);const saved=await service.history(backend.state.project!.id);assert.equal(saved.turns!.at(-1)!.status,'failed');assert.equal(saved.turns!.at(-1)!.committedRevision,0);assert.ok(!service.hasActiveTurn());
}));

test('shutdown waits canceled turn and restores pending turn as interrupted after restart',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.holdPreview=true;const provider=await new MockProvider(directory,()=>firstPlan()).ready(),service=new ConversationService(backend,provider,directory);
  const pending=service.send(chat('制作一个视频'));const rejection=assert.rejects(pending,/取消/);while(!backend.state.task)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(service.activity().running,true);assert.equal((await service.history(backend.state.project!.id)).turns!.at(-1)!.status,'pending');await service.shutdown();await rejection;const stored=await service.history(backend.state.project!.id);assert.equal(stored.turns!.at(-1)!.status,'cancelled');
  const file=join(directory,'conversations',createHash('sha256').update(backend.state.project!.id).digest('hex')+'.json');const raw=JSON.parse(await readFile(file,'utf8'));raw.turns.at(-1).status='pending';raw.messages.at(-1).status='pending';await writeFile(file,JSON.stringify(raw));const restored=await new ConversationService(backend,provider,directory).history(backend.state.project!.id);assert.equal(restored.turns!.at(-1)!.status,'interrupted');assert.equal(JSON.parse(await readFile(file,'utf8')).turns.at(-1).status,'interrupted');
}));

test('vision requires explicit per-turn authorization and enforces selected asset scope/bytes/dimensions',()=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('images','topic');backend.state.root=join(directory,'project');await mkdir(join(backend.state.root,'assets'),{recursive:true});const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);await writeFile(join(backend.state.root,'assets','small.png'),png);
  backend.state.project.assets.push({id:'image-a',kind:'image',name:'图A',description:'',path:'assets/small.png'});backend.state.project.shots[0]!.assetIds=['image-a'];const config={id:'custom',name:'vision',baseUrl:'https://mock.invalid/v1',model:'vision-model',supportsVision:true,enableVision:true,maxVisionBytes:1024,maxVisionDimension:128};const input={...chat('观察这张图片',backend.state.project.id),shotId:backend.state.project.shots[0]!.id,imageAssetIds:['image-a']},signal=new AbortController().signal;
  assert.equal((await authorizedImages(backend.state,input,config,signal)).content.length,0);const sent=await authorizedImages(backend.state,{...input,allowImageUpload:true},config,signal);assert.equal(sent.ids[0],'image-a');assert.ok(sent.content.some(block=>block.type==='image_url'));
  await assert.rejects(authorizedImages(backend.state,{...input,allowImageUpload:true,shotId:backend.state.project.shots[1]!.id},config,signal),/未绑定/);png.writeUInt32BE(5000,16);await writeFile(join(backend.state.root,'assets','small.png'),png);await assert.rejects(authorizedImages(backend.state,{...input,allowImageUpload:true},config,signal),/像素尺寸/);
}));

test('vision refuses project-local file symlinks before reading image pixels',context=>withDirectory(async directory=>{
  const backend=new FixtureBackend();backend.state.project=createProject('symlink image','topic');backend.state.root=join(directory,'project');await mkdir(join(backend.state.root,'assets'),{recursive:true});
  const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);await writeFile(join(backend.state.root,'assets','small.png'),png);
  backend.state.project.assets.push({id:'image-a',kind:'image',name:'图A',description:'',path:'assets/link.png'});backend.state.project.shots[0]!.assetIds=['image-a'];
  const config={id:'custom',name:'vision',baseUrl:'https://mock.invalid/v1',model:'vision-model',supportsVision:true,enableVision:true,maxVisionBytes:1024,maxVisionDimension:128};const input={...chat('观察这张图片',backend.state.project.id),shotId:backend.state.project.shots[0]!.id,imageAssetIds:['image-a'],allowImageUpload:true};
  if(!await createFileSymlinkOrSkip(context,join(backend.state.root,'assets','small.png'),join(backend.state.root,'assets','link.png')))return;
  await assert.rejects(authorizedImages(backend.state,input,config,new AbortController().signal),/Symlinks/);
}));
