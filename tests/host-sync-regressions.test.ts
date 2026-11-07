import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../src/host/store.ts';
import {StudioService,speechPreflightFailure} from '../src/host/service.ts';
import type {HostContext} from '../src/host/platform.ts';
import type {ExportResult,StudioSnapshot} from '../src/shared/types.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
const ctx:HostContext={llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('Unexpected provider call');}},credentials:{async get(){return undefined;},async set(){},async delete(){}}};
function serviceAt(baseDirectory:string){
  const service=new StudioService(ctx,{baseDirectory,restoreRecent:false});
  service.renderer.assetBaseUrl=async()=> 'http://localhost:1/';
  service.renderer.preview=async(_root,project)=>`http://localhost:1/?revision=${project.revision}`;
  service.renderer.audioPreview=async()=>null;
  service.renderer.check=async()=>({ok:true,errors:[],frames:[]});
  return service;
}
async function call<T=StudioSnapshot>(service:StudioService,endpoint:string,payload:unknown={}):Promise<T>{const result=await service.rpc(endpoint,payload);assert.equal(result.ok,true,result.ok?'':result.error.message);return result.ok?result.value as T:undefined as T;}
function output(root:string,revision:number):ExportResult{return {id:'fixture-export',path:join(root,'exports','fixture-export','video.mp4'),createdAt:new Date().toISOString(),revision,width:1920,height:1080,frameCount:900,duration:30};}

test('cross-store commit, open and history wait for the same project transaction; stale writers fail CAS',async()=>{
  const baseDirectory=await mkdtemp(join(tmpdir(),'yingliu-store-queue-')),entered=deferred(),release=deferred();
  const initialStore=new ProjectStore({baseDirectory});
  let pending:Promise<unknown>[]=[];
  try{
    const initial=await initialStore.create({title:'跨实例提交'});
    const writer=new ProjectStore({baseDirectory,async onCommitPhase(phase){if(phase==='staged'){entered.resolve();await release.promise;}}});
    const first=structuredClone(initial.project);first.revision++;first.title='首个写入';
    const committing=writer.commit(initial.root,first,{}, {expectedRevision:0});pending.push(committing);await entered.promise;
    const reader=new ProjectStore({baseDirectory}),stale=structuredClone(first);stale.title='过期写入';
    let opened=false,historyRead=false;
    const opening=reader.open(initial.root).then(project=>{opened=true;return project;});
    const history=reader.history(initial.root).then(value=>{historyRead=true;return value;});
    const rejected=assert.rejects(reader.commit(initial.root,stale,{}, {expectedRevision:0}),{code:'REVISION_CONFLICT'});
    pending.push(opening,history,rejected);
    // The staged file must not be removed by open() from another store instance.
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(opened,false);assert.equal(historyRead,false);
    release.resolve();await committing;
    assert.equal((await opening).revision,1);assert.equal((await history).entries.length,2);await rejected;
    assert.equal((await initialStore.open(initial.root)).title,'首个写入');
  }finally{release.resolve();await Promise.allSettled(pending);await rm(baseDirectory,{recursive:true,force:true});}
});

test('undo and redo retain export receipts and project associations across reopening',async()=>{
  const baseDirectory=await mkdtemp(join(tmpdir(),'yingliu-history-receipts-'));
  try{
    const store=new ProjectStore({baseDirectory}),initial=await store.create({title:'初稿'}),edited=structuredClone(initial.project);edited.revision++;edited.title='二稿';
    await store.commit(initial.root,edited,{}, {expectedRevision:0});
    const recorded=structuredClone(edited);recorded.revision++;recorded.outputs=[output(initial.root,1)];recorded.sessionIds=['retained-session'];recorded.extensions.sessionIds=['retained-session'];
    await store.commit(initial.root,recorded,{}, {expectedRevision:1});
    const first=await store.moveHistory(initial.root,'undo',2),second=await store.moveHistory(initial.root,'undo',3);
    assert.equal(first.outputs[0]!.revision,1);assert.equal(second.title,'初稿');assert.equal(second.revision,4);
    const restarted=new ProjectStore({baseDirectory}),opened=await restarted.open(initial.root);
    assert.deepEqual(opened.outputs,recorded.outputs);assert.deepEqual(opened.sessionIds,recorded.sessionIds);assert.deepEqual(opened.extensions.sessionIds,recorded.extensions.sessionIds);
    const redone=await restarted.moveHistory(initial.root,'redo',4);assert.equal(redone.title,'二稿');assert.deepEqual(redone.outputs,recorded.outputs);
  }finally{await rm(baseDirectory,{recursive:true,force:true});}
});

test('export progress stays current and completion is published after the final durable journal',async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-durable-task-')),service=serviceAt(base),workGate=deferred(),journalGate=deferred(),journalEntered=deferred(),journalWritten=deferred(),publishGate=deferred();
  try{
    const initial=await call(service,'create',{title:'任务落盘'});
    service.renderer.export=async(root,project,_settings,_signal,progress)=>{progress(.42,'捕帧到 42%');await workGate.promise;return output(root,project.revision);};
    const internal=service as unknown as {writeTaskJournal(root:string,task:{kind:string;status:string}):Promise<void>},write=internal.writeTaskJournal.bind(service);
    internal.writeTaskJournal=async(root,task)=>{if(task.kind==='export'&&task.status==='complete'){journalEntered.resolve();await journalGate.promise;await write(root,task);journalWritten.resolve();await publishGate.promise;}else await write(root,task);};
    const started=await call(service,'export',{expectedRevision:initial.project!.revision});
    const tasks=await call<{tasks:{id:string;progress:number;message:string}[]}>(service,'tasks');
    const running=tasks.tasks.find(task=>task.id===started.task!.id)!;assert.equal(running.progress,.42);assert.equal(running.message,'捕帧到 42%');
    workGate.resolve();await journalEntered.promise;
    assert.equal((await service.snapshot()).task!.status,'running');
    assert.equal(JSON.parse(await readFile(started.task!.logPath!,'utf8')).status,'running');
    journalGate.resolve();await journalWritten.promise;
    const finalizing=await call<{tasks:{id:string;status:string}[]}>(service,'tasks');assert.equal(finalizing.tasks.find(task=>task.id===started.task!.id)!.status,'running');
    publishGate.resolve();await service.dispose();
    const terminal=JSON.parse(await readFile(started.task!.logPath!,'utf8'));assert.equal(terminal.status,'complete');assert.equal(terminal.progress,1);assert.ok(terminal.finishedAt);
  }finally{workGate.resolve();journalGate.resolve();publishGate.resolve();await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('a saved edit with preview failure keeps the running export and its snapshot receipt',async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-export-edit-')),service=serviceAt(base),release=deferred();
  try{
    const initial=await call(service,'create',{title:'导出原稿'});
    service.renderer.export=async(root,project)=>{await release.promise;return output(root,project.revision);};
    const started=await call(service,'export',{expectedRevision:initial.project!.revision}),next=structuredClone(initial.project!);next.title='导出中的编辑';
    service.renderer.preview=async()=>{throw new Error('fixture preview failure');};
    const saved=await call(service,'save',{project:next,expectedRevision:initial.project!.revision});
    assert.equal(saved.project!.title,next.title);assert.equal(saved.task!.id,started.task!.id);assert.equal(saved.task!.status,'running');
    release.resolve();
    const deadline=Date.now()+3000;let current=await service.snapshot();while(current.task!.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,5));current=await service.snapshot();}
    assert.equal(current.task!.status,'complete');assert.equal(current.project!.outputs[0]!.revision,initial.project!.revision);assert.equal(current.project!.title,next.title);
    const tasks=await call<{tasks:{kind:string;status:string}[]}>(service,'tasks');assert.ok(tasks.tasks.some(task=>task.kind==='preview'&&task.status==='failed'));
  }finally{release.resolve();await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('duplicate source patches and failed opening preserve the current committed project',async()=>{
  const base=await mkdtemp(join(tmpdir(),'yingliu-apply-open-')),service=serviceAt(base);
  try{
    const initial=await call(service,'create',{title:'保持工程'}),shotId=initial.project!.shots[0]!.id,source=await call(service,'source',{shotId});
    const duplicate=await service.rpc('apply',{title:'不得写入',expectedRevision:0,sources:[{shotId,source},{shotId,source}]});assert.equal(duplicate.ok,false);if(!duplicate.ok)assert.match(duplicate.error.message,/重复/);
    const failed=await service.rpc('open',{path:join(base,'missing-project')});assert.equal(failed.ok,false);
    const current=await call(service,'current');assert.equal(current.root,initial.root);assert.equal(current.project!.revision,0);assert.equal(current.project!.title,'保持工程');
  }finally{await service.dispose();await rm(base,{recursive:true,force:true});}
});

test('speech preflight classification preserves a frozen provider error as its cause',()=>{
  const original=Object.freeze(Object.assign(new Error('fixture preflight error'),{submissionUncertain:true})),classified=speechPreflightFailure(original);
  assert.equal(classified.submissionUncertain,false);assert.equal(classified.message,original.message);assert.equal(classified.cause,original);assert.equal(original.submissionUncertain,true);
});
