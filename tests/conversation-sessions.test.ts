import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDatabase } from '../src/agent/database.ts';
import { AgentRepository, candidateHash } from '../src/agent/repository.ts';
import { ConversationSessions } from '../src/app/conversation-sessions.ts';
import { ProviderManager, type ModelMessage } from '../src/app/model.ts';
import type { BackendPort, ChatInput, Conversation, SecretStore } from '../src/app/contracts.ts';
import type { RpcResult, StudioSnapshot, VideoProject } from '../src/shared/types.ts';
import { createProject, defaultSceneSource } from '../src/core/index.ts';

class Secrets implements SecretStore {values=new Map<string,string>();async get(id:string){return this.values.get(id);}async set(id:string,value:string){this.values.set(id,value);}async delete(id:string){this.values.delete(id);}}
class Models extends ProviderManager {
  responder:(messages:ModelMessage[],signal:AbortSignal)=>unknown|Promise<unknown>=()=>({intent:'chat',done:true,message:'你好',actions:[]});
  calls=0;
  override async complete(messages:ModelMessage[],_system:string,signal:AbortSignal){this.calls++;return JSON.stringify(await this.responder(messages,signal));}
}
class Backend implements BackendPort {
  project=createProject('工程','测试');projects=new Map<string,VideoProject>();receipts=new Map<string,{committedRevision:number}>();sources=new Map<string,unknown>();loseCreateReceipt=false;
  constructor(){this.projects.set(this.project.id,this.project);}
  snapshot(project:VideoProject|null):StudioSnapshot{return {project:project?structuredClone(project):null,root:null,task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'fixture',browserAvailable:true,ffmpegPath:'fixture',ffmpegAvailable:true,ffprobePath:'fixture',ffprobeAvailable:true}};}
  async call<T=StudioSnapshot>(endpoint:string,payload:any={}):Promise<T>{
    if(endpoint==='current')return this.snapshot(payload.projectId?this.projects.get(payload.projectId)??null:this.project) as T;
    if(endpoint==='candidate.validate')return {id:randomUUID(),candidateHash:candidateHash(payload.candidate),baseRevision:payload.expectedRevision??0,status:'passed',checks:['structure','syntax','assets','runtime'].map(id=>({id,status:'passed'})),frames:[],validatorVersion:'test',createdAt:new Date().toISOString()} as T;
    if(endpoint==='create'){const project=structuredClone(payload.project);this.projects.set(project.id,project);this.receipts.set(payload.operation.id,{committedRevision:project.revision});if(this.loseCreateReceipt){this.loseCreateReceipt=false;throw new Error('create response lost');}return this.snapshot(project) as T;}
    if(endpoint==='apply'){const project=structuredClone(payload.project);project.revision++;this.projects.set(project.id,project);for(const source of payload.sources??[])this.sources.set(source.shotId,source.source);return this.snapshot(project) as T;}
    if(endpoint==='operation.get')return this.receipts.get(payload.operationId) as T;
    throw new Error('Unexpected backend call '+endpoint);
  }
  async route(endpoint:string,payload?:unknown):Promise<RpcResult>{return {ok:true,value:await this.call(endpoint,payload)};}
}
async function fixture(t:test.TestContext){
  const directory=await mkdtemp(join(tmpdir(),'yingliu-session-runtime-')),repos=new Map<string,AgentRepository>(),backend=new Backend(),providers=new Models(directory,new Secrets());await providers.save({apiKey:'fixture-only'});
  const repositoryFor=async(projectId?:string)=>{const key=projectId??'lobby';let repo=repos.get(key);if(!repo){repo=new AgentRepository(new AgentDatabase(join(directory,key+'.sqlite')),key);repos.set(key,repo);}await repo.initialize();return repo;};
  const options={backend,providers,dataDirectory:directory,repositoryFor};const sessions=new ConversationSessions(options),other=new ConversationSessions(options);
  t.after(async()=>{await sessions.shutdown();await other.shutdown();for(const repo of repos.values())await repo.database.close();await rm(directory,{recursive:true,force:true});});
  const input=(sessionId:string,projectId?:string,message='你好'):ChatInput=>({sessionId,operationId:randomUUID(),expectedRevision:projectId?0:null,projectId,message,provider:'custom',model:'deepseek-chat'});
  return {directory,backend,providers,repositoryFor,sessions,other,input,options};
}

test('separate sessions retain independent histories and operation replay checks the original request',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,a=await f.sessions.create({projectId,name:'甲'}),b=await f.sessions.create({projectId,name:'乙'});
  const request={...f.input(a.id,projectId),projectId:undefined};await f.sessions.send(request);await f.sessions.send(f.input(b.id,projectId,'你好，乙'));
  const ha=await f.sessions.history({sessionId:a.id,projectId}),hb=await f.sessions.history({sessionId:b.id,projectId});assert.equal(ha.turns?.length,1);assert.equal(hb.turns?.length,1);assert.notEqual(ha.messages[0]?.content,hb.messages[0]?.content);
  const calls=f.providers.calls;await f.sessions.send(request);assert.equal(f.providers.calls,calls);await assert.rejects(f.sessions.send({...request,message:'修改第二镜'}),{code:'OPERATION_MISMATCH'});
});

test('two facade instances cannot run the same session while another session can progress',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,a=await f.sessions.create({projectId}),b=await f.sessions.create({projectId});let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
  f.providers.responder=async(messages,signal)=>{if(JSON.stringify(messages).includes('等待甲')){entered();await Promise.race([blocked,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);}return {intent:'chat',done:true,message:'收到',actions:[]};};
  const pending=f.sessions.send({...f.input(a.id,projectId,'等待甲'),intent:'chat'});await started;
  await assert.rejects(f.other.send(f.input(a.id,projectId)));await f.other.send(f.input(b.id,projectId));release();await pending;assert.equal((await f.sessions.history({sessionId:b.id,projectId})).turns?.at(-1)?.status,'succeeded');
});

test('legacy conversations migrate once without replay and retain committed failure evidence',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id;await mkdir(join(f.directory,'conversations'),{recursive:true});const path=join(f.directory,'conversations',createHash('sha256').update(projectId).digest('hex')+'.json');
  await writeFile(path,JSON.stringify({id:'legacy-conversation',projectId,provider:'custom',model:'deepseek-chat',messages:[{id:'message',role:'user',content:'添加尾声',turnId:'turn',status:'pending',createdAt:'2026-01-01'}],turns:[{id:'turn',request:{projectId,message:'添加尾声',provider:'custom',model:'deepseek-chat'},status:'pending',committedRevision:0,createdAt:'2026-01-01',updatedAt:'2026-01-01'}]}));
  const first=await f.sessions.list({projectId}),second=await f.sessions.list({projectId});assert.equal(first.length,1);assert.equal(second[0]?.id,first[0]?.id);const history=await f.sessions.history({sessionId:first[0]!.id,projectId});assert.equal(history.turns?.[0]?.status,'interrupted');assert.equal(history.turns?.[0]?.committedRevision,0);assert.equal(history.turns?.[0]?.phase,'reconciling');assert.equal(f.providers.calls,0);assert.equal(JSON.parse(await readFile(path,'utf8')).turns[0].status,'pending');
});

test('task control is fenced by task identity and generation',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,session=await f.sessions.create({projectId}),repo=await f.repositoryFor(projectId);const task=await repo.createTask({sessionId:session.id,goal:'等待',scope:{shotIds:['*'],writeFields:['*'],capabilities:['read']}}),lease=await repo.claimTask(task.id,'test-owner');
  await assert.rejects(f.sessions.cancel({sessionId:session.id,projectId,taskId:task.id,generation:lease.generation-1}));assert.equal((await repo.getTask(task.id)).status,'preflight');
  await f.sessions.control('pause',{sessionId:session.id,projectId,taskId:task.id,generation:lease.generation});assert.equal((await repo.getTask(task.id)).status,'paused');
  await assert.rejects(f.sessions.cancel({sessionId:session.id,projectId,taskId:task.id,generation:lease.generation}));
});

test('first creation records an outbox, transfers session and task, and returns a durable project session',async t=>{
  const f=await fixture(t),session=await f.sessions.create();f.providers.responder=()=>({intent:'create',done:true,message:'制作初稿',actions:[{tool:'video_update',arguments:{expectedRevision:0,update:{storyboard:{shots:[{title:'镜头',durationSeconds:2}]},sourcesByIndex:[defaultSceneSource()]}}}]});
  const request={...f.input(session.id,undefined,'制作一个视频'),intent:'create' as const},result=await f.sessions.send(request),projectId=result.snapshot.project!.id;const located=await f.sessions.history({sessionId:session.id});assert.equal(located.projectId,projectId);assert.equal(located.turns?.at(-1)?.status,'succeeded');const calls=f.providers.calls;await f.sessions.send(request);assert.equal(f.providers.calls,calls);
  const target=await f.repositoryFor(projectId),tasks=await target.listTasks({sessionId:session.id});assert.equal(tasks.length,1);assert.equal(tasks[0]?.status,'succeeded');assert.equal(tasks[0]?.committedRevision,0);
  const lobby=await f.repositoryFor(),[outbox]=await lobby.database.query<{state:string}>('SELECT state FROM conversation_create_outbox WHERE session_id=?',[session.id]);assert.equal(outbox?.state,'migrated');await f.sessions.list();assert.equal((await f.sessions.history({sessionId:session.id})).projectId,projectId);
});

test('lost create response reconciles the receipt and retry only validates the existing project',async t=>{
  const f=await fixture(t),session=await f.sessions.create();f.backend.loseCreateReceipt=true;f.providers.responder=()=>({intent:'create',done:true,message:'制作初稿',actions:[{tool:'video_update',arguments:{expectedRevision:0,update:{storyboard:{shots:[{title:'镜头',durationSeconds:2}]},sourcesByIndex:[defaultSceneSource()]}}}]});
  await assert.rejects(f.sessions.send({...f.input(session.id,undefined,'制作一个视频'),intent:'create'}),/create response lost/);
  const history=await f.sessions.history({sessionId:session.id}),projectId=history.projectId!;assert.ok(projectId);assert.equal(history.turns?.at(-1)?.committedRevision,0);
  const repo=await f.repositoryFor(projectId),task=(await repo.listTasks({sessionId:session.id}))[0]!,calls=f.providers.calls,projectCount=f.backend.projects.size;
  await f.sessions.control('retry',{sessionId:session.id,projectId,taskId:task.id,generation:task.generation,expectedRevision:0});
  assert.equal(f.providers.calls,calls);assert.equal(f.backend.projects.size,projectCount);assert.equal((await f.sessions.history({sessionId:session.id})).turns?.at(-1)?.status,'succeeded');
});


test('read-only conversation grants cannot generate media or commit project changes',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,session=await f.sessions.create({projectId});await f.sessions.send(f.input(session.id,projectId));const repo=await f.repositoryFor(projectId),task=(await repo.listTasks({sessionId:session.id}))[0]!;assert.deepEqual(task.scope.writeFields,[]);assert.ok(!task.scope.capabilities.includes('commit'));assert.ok(!task.scope.capabilities.includes('image'));assert.ok(task.modelSnapshot);
});

test('preflight failures release the session and preserve an actionable failed turn',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,session=await f.sessions.create({projectId});await f.providers.save({apiKey:''});await assert.rejects(f.sessions.send(f.input(session.id,projectId)),/API Key/);
  const repo=await f.repositoryFor(projectId),task=(await repo.listTasks({sessionId:session.id}))[0]!;assert.equal(task.status,'failed');const history=await f.sessions.history({sessionId:session.id,projectId});assert.equal(history.turns?.at(-1)?.taskId,task.id);assert.equal(history.turns?.at(-1)?.status,'failed');assert.equal((await repo.database.query('SELECT * FROM session_activity WHERE session_id=?',[session.id])).length,0);
});

test('unfinished children block the root before publishing or projecting success',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,session=await f.sessions.create({projectId}),repo=await f.repositoryFor(projectId),shot=f.backend.project.shots[0]!,before=structuredClone(f.backend.project);
  f.providers.responder=async()=>{const parent=(await repo.listTasks({sessionId:session.id}))[0]!,childSession=await repo.createSession({kind:'subagent',parentSessionId:session.id});await repo.createTask({sessionId:childSession.id,parentTaskId:parent.id,goal:'读取镜头',scope:{shotIds:[shot.id],writeFields:[],capabilities:['read']}});return {intent:'modify',done:true,message:'颜色已修改',actions:[{tool:'video_update',arguments:{expectedRevision:0,update:{shotPatches:[{id:shot.id,patch:{params:{background:'#123456'}}}]}}}]};};
  await assert.rejects(f.sessions.send({...f.input(session.id,projectId,'修改第一镜颜色'),intent:'modify'}),{code:'CHILDREN_PENDING'});
  const parent=(await repo.listTasks({sessionId:session.id}))[0]!,children=await repo.listTasks({parentTaskId:parent.id}),history=await f.sessions.history({sessionId:session.id,projectId});assert.equal(parent.status,'blocked');assert.equal(parent.committedRevision,undefined);assert.equal(children[0]?.status,'queued');assert.equal(history.turns?.at(-1)?.phase,'blocked');assert.notEqual(history.turns?.at(-1)?.status,'succeeded');assert.deepEqual(f.backend.project,before);
});

test('resuming restores accepted local artifacts without asking the model to copy source',async t=>{
  const f=await fixture(t),projectId=f.backend.project.id,session=await f.sessions.create({projectId}),repo=await f.repositoryFor(projectId),request={...f.input(session.id,projectId,'修改第一镜画面'),intent:'modify' as const},base=structuredClone(f.backend.project),shotId=base.shotOrder[0]!,source={...defaultSceneSource(),html:'<main>PRIVATE_RESTORED_ARTIFACT</main>'};
  const task=await repo.createTask({sessionId:session.id,operationId:request.operationId,goal:request.message,scope:{shotIds:[shotId],writeFields:['*'],capabilities:['read','validate','commit']}}),lease=await repo.claimTask(task.id,'previous-executor');await repo.beginOperation(lease,'accepted-before-crash',{tool:'agent_accept',args:{candidateId:'accepted-child'}});await repo.finishOperation(lease,'accepted-before-crash','complete',{receipt:{candidateId:'accepted-child',summary:'成员已验收'},acceptedCandidate:{project:base,sources:{[shotId]:source},baseRevision:0}});await repo.transition(lease,'failed',{error:'process interrupted'});
  const stored=await repo.getSession<Conversation>(session.id),history=stored.data;history.turns=[{id:'interrupted-turn',taskId:task.id,operationId:request.operationId,request,status:'interrupted',createdAt:'2026-01-01',updatedAt:'2026-01-01'}];await repo.saveSessionData(session.id,history,stored.version);
  f.providers.responder=messages=>{assert.ok(!JSON.stringify(messages).includes('PRIVATE_RESTORED_ARTIFACT'));return {intent:'modify',done:true,message:'应用已验收候选',actions:[]};};
  let rechecked=0;const restored=new ConversationSessions({...f.options,externalTool:async(tool,args)=>{assert.equal(tool,'agent_accept');assert.equal(args.candidateId,'accepted-child');rechecked++;return {acceptedCandidate:{project:base,sources:{[shotId]:source},baseRevision:0},snapshot:f.backend.snapshot(base)};}});t.after(()=>restored.shutdown());
  const result=await restored.send({...f.input(session.id,projectId,''),retryTurnId:'interrupted-turn'});assert.equal(rechecked,1);assert.equal(result.conversation.turns?.at(-1)?.status,'succeeded');assert.deepEqual(f.backend.sources.get(shotId),source);assert.equal(result.snapshot.project?.revision,1);
});
