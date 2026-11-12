import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork,type ChildProcess} from 'node:child_process';
import {ProjectStore,type CommitOperation} from '../src/host/store.ts';
import {AgentDatabase} from '../src/agent/database.ts';
import {createProject} from '../src/core/index.ts';

async function fixture(){const baseDirectory=await mkdtemp(join(tmpdir(),'yingliu-sqlite-storage-'));return {baseDirectory,store:new ProjectStore({baseDirectory}),async close(){await rm(baseDirectory,{recursive:true,force:true});}};}
interface Result {ok:boolean;revision?:number;title?:string;code?:string}
function writer(root:string,title:string,operation?:CommitOperation){
  const child=fork(new URL('./fixtures/storage-process.ts',import.meta.url),[root,title,...(operation?[JSON.stringify(operation)]:[])],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  return observeWriter(child);
}
function observeWriter(child:ChildProcess){
  let errors='';child.stderr?.on('data',data=>{errors+=data;});
  const message=<T>(key:string)=>new Promise<T>((resolve,reject)=>{
    let delivered=false;
    const timer=setTimeout(()=>{child.kill();reject(new Error('storage fixture timeout: '+errors));},15000);
    child.on('message',value=>{if(value&&typeof value==='object'&&key in value){delivered=true;clearTimeout(timer);resolve((value as Record<string,T>)[key]!);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if(!delivered)reject(new Error('storage fixture exited '+code+' before '+key+': '+errors));});
  });
  const ready=message<boolean>('ready'),result=message<Result>('result');
  return {child,ready,result};
}

test('two actual processes racing the same revision publish exactly one complete HEAD',async()=>{
  const f=await fixture();const children:ReturnType<typeof writer>[]=[];
  try{
    const created=await f.store.create({title:'多进程 CAS'});
    children.push(writer(created.root,'进程甲',{id:'write-a',payloadHash:'a'}),writer(created.root,'进程乙',{id:'write-b',payloadHash:'b'}));
    await Promise.all(children.map(child=>child.ready));children.forEach(child=>child.child.send('release'));
    const results=await Promise.all(children.map(child=>child.result));
    assert.equal(results.filter(result=>result.ok).length,1);assert.equal(results.find(result=>!result.ok)?.code,'REVISION_CONFLICT');
    const head=await new ProjectStore({baseDirectory:f.baseDirectory}).readProject(created.root);
    assert.equal(head.revision,1);assert.equal(head.title,results.find(result=>result.ok)?.title);
    assert.equal((await f.store.history(created.root)).entries.length,2);
  }finally{children.forEach(child=>child.child.kill());await f.close();}
});

test('creation survives a pre-HEAD process crash and fences an expired creator after takeover',async()=>{
  const f=await fixture();const children:ReturnType<typeof observeWriter>[]=[];
  try{
    const project=createProject('恢复首个提交');project.assets.push({id:'fixture-image',kind:'image',name:'不可变素材',description:'storage-only fixture',path:'assets/fixture.png',mime:'image/png'});
    const input={project,assetFiles:[{path:'assets/fixture.png',dataBase64:Buffer.from('immutable-create-fixture').toString('base64')}]},operation={id:'recover-create',payloadHash:'original-create-content'},root=join(f.baseDirectory,project.id);
    const start=()=>{const child=observeWriter(fork(new URL('./fixtures/storage-create-process.ts',import.meta.url),[f.baseDirectory,JSON.stringify(input),JSON.stringify(operation)],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']}));children.push(child);return child;};
    const first=start();await first.ready;
    const database=new AgentDatabase(join(root,'.studio/state.sqlite'));
    try{
      // Advance only this fixture's persisted expiry instead of waiting thirty seconds.
      await database.transaction([{sql:'UPDATE store_creation SET lease_expires_at=0'}]);
      const second=start();await second.ready;
      first.child.send('release');assert.equal((await first.result).code,'CREATE_LEASE_LOST');
      const crashed=assert.rejects(second.result,/exited/),stopped=new Promise<void>(resolve=>second.child.once('exit',()=>resolve()));second.child.kill('SIGKILL');await Promise.all([crashed,stopped]);
      assert.equal((await database.query('SELECT * FROM store_head')).length,0);
      await database.transaction([{sql:'UPDATE store_creation SET lease_expires_at=0'}]);
      const recovered=await f.store.create(input,operation);assert.equal(recovered.project.revision,0);
      assert.equal(await readFile(join(root,'assets/fixture.png'),'utf8'),'immutable-create-fixture');
      assert.equal((await database.query<{generation:number}>('SELECT generation FROM store_creation'))[0]?.generation,3);
      assert.equal((await database.query('SELECT * FROM store_head')).length,1);assert.equal((await database.query('SELECT * FROM store_operations')).length,1);
      await assert.rejects(f.store.create({...input,project:{...project,title:'冲突标题'}},{...operation,payloadHash:'different-content'}),error=>(error as {code?:string}).code==='OPERATION_ID_REUSE');
    }finally{await database.close();}
  }finally{children.forEach(child=>child.child.kill());await f.close();}
});

test('concurrent duplicate operations return one receipt, and replay survives undo and restart',async()=>{
  const f=await fixture();const children:ReturnType<typeof writer>[]=[];
  try{
    const created=await f.store.create({title:'幂等提交'}),operation={id:'same-operation',payloadHash:'same-content'};
    children.push(writer(created.root,'唯一提交',operation),writer(created.root,'唯一提交',operation));
    await Promise.all(children.map(child=>child.ready));children.forEach(child=>child.child.send('release'));
    const results=await Promise.all(children.map(child=>child.result));assert.ok(results.every(result=>result.ok&&result.revision===1));
    const receipt=await f.store.operationReceipt(created.root,operation.id);assert.equal(receipt?.committedRevision,1);
    await f.store.moveHistory(created.root,'undo',1,{id:'undo-once',payloadHash:'undo-1'});
    const restarted=new ProjectStore({baseDirectory:f.baseDirectory}),replayProject={...created.project,revision:1,title:'唯一提交'};
    assert.equal((await restarted.commit(created.root,replayProject,{}, {expectedRevision:0,operation})).revision,1);
    assert.equal((await restarted.moveHistory(created.root,'undo',1,{id:'undo-once',payloadHash:'undo-1'})).revision,2);
    assert.equal((await restarted.readProject(created.root)).revision,2);assert.equal((await restarted.readProject(created.root)).title,created.project.title);
    await assert.rejects(restarted.commit(created.root,replayProject,{}, {expectedRevision:0,operation:{...operation,payloadHash:'different'}}),error=>(error as {code?:string}).code==='OPERATION_ID_REUSE');
  }finally{children.forEach(child=>child.child.kill());await f.close();}
});

test('legacy state migrates once with a backup, immutable historical reads and no JSON fallback',async()=>{
  const f=await fixture();
  try{
    const created=await f.store.create({title:'旧状态迁移'}),next={...created.project,revision:1,title:'旧状态第二版'};
    await f.store.commit(created.root,next,{}, {expectedRevision:0});
    const database=new AgentDatabase(join(created.root,'.studio/state.sqlite'));
    const head=(await database.query<{current:string;undo_json:string;redo_json:string}>('SELECT * FROM store_head'))[0]!;
    await database.close();await rm(join(created.root,'.studio/state.sqlite'));
    const legacy={version:1,current:head.current,undo:JSON.parse(head.undo_json),redo:JSON.parse(head.redo_json)};
    await writeFile(join(created.root,'.studio/state.json'),JSON.stringify(legacy));
    const reopened=new ProjectStore({baseDirectory:f.baseDirectory});assert.equal((await reopened.open(created.root)).revision,1);
    assert.deepEqual(JSON.parse(await readFile(join(created.root,'.studio/legacy-state-v1.json'),'utf8')),legacy);
    assert.equal(JSON.parse(await readFile(join(created.root,'.studio/state.json'),'utf8')).version,2);
    assert.equal((await reopened.readProject(created.root,0)).title,created.project.title);
    await rm(join(created.root,'.studio/state.sqlite'));
    await assert.rejects(reopened.open(created.root),error=>(error as {code?:string}).code==='STORE_DATABASE_MISSING');
  }finally{await f.close();}
});

test('task and service fences are checked in the same transaction as HEAD and the receipt',async()=>{
  const f=await fixture();
  try{
    const created=await f.store.create({title:'租约栅栏'}),database=new AgentDatabase(join(created.root,'.studio/state.sqlite'));
    try{
      await database.transaction([
        {sql:'CREATE TABLE agent_tasks(id TEXT PRIMARY KEY,project_id TEXT,session_id TEXT,generation INTEGER,lease_owner TEXT,lease_expires_at INTEGER,status TEXT,committed_revision INTEGER,version INTEGER)'},
        {sql:'CREATE TABLE service_records(kind TEXT,id TEXT,project_id TEXT,owner TEXT,generation INTEGER,lease_until INTEGER,stop_requested INTEGER)'},
        {sql:'INSERT INTO agent_tasks VALUES(?,?,?,?,?,?,?,?,?)',params:['task',created.project.id,'session',2,'new-worker',Date.now()+60000,'committing',null,1]},
        {sql:'INSERT INTO service_records VALUES(?,?,?,?,?,?,?)',params:['workflow','flow',created.project.id,'worker',1,Date.now()+60000,1]},
      ]);
      const next={...created.project,revision:1,title:'有资格才发布'};
      const taskOperation={id:'fenced-task',payloadHash:'task-content',taskId:'task',sessionId:'session',generation:1,leaseOwner:'old-worker'};
      await assert.rejects(f.store.commit(created.root,next,{}, {expectedRevision:0,operation:taskOperation}),error=>(error as {code?:string}).code==='LEASE_LOST');
      const serviceOperation:CommitOperation={id:'fenced-service',payloadHash:'service-content',taskId:'flow',serviceFence:{kind:'workflow',id:'flow',owner:'worker',generation:1}};
      await assert.rejects(f.store.commit(created.root,next,{}, {expectedRevision:0,operation:serviceOperation}),error=>(error as {code?:string}).code==='TASK_LEASE_LOST');
      assert.equal((await f.store.readProject(created.root)).revision,0);assert.equal(await f.store.operationReceipt(created.root,taskOperation.id),undefined);
      await f.store.commit(created.root,next,{}, {expectedRevision:0,operation:{...taskOperation,generation:2,leaseOwner:'new-worker'}});
      assert.equal((await database.query<{committed_revision:number}>('SELECT committed_revision FROM agent_tasks'))[0]?.committed_revision,1);
      assert.equal((await f.store.operationReceipt(created.root,taskOperation.id))?.committedRevision,1);
      await assert.rejects(f.store.commit(created.root,{...next,revision:2}, {},{expectedRevision:1,operation:{...taskOperation,id:'task-second-commit',generation:2,leaseOwner:'new-worker'}}),error=>(error as {code?:string}).code==='LEASE_LOST');
      assert.equal((await f.store.readProject(created.root)).revision,1);
      await database.transaction([{sql:'UPDATE service_records SET stop_requested=0'}]);
      await f.store.commit(created.root,{...next,revision:2}, {},{expectedRevision:1,operation:serviceOperation});
      assert.equal((await f.store.readProject(created.root)).revision,2);
    }finally{await database.close();}
  }finally{await f.close();}
});

test('create operation replay uses the original project and opening preserves another writer staging file',async()=>{
  const f=await fixture();
  try{
    const project=createProject('重放创建'),operation={id:'create-once',payloadHash:'creation'};
    const created=await f.store.create(project,operation),replayed=await new ProjectStore({baseDirectory:f.baseDirectory}).create(project,operation);
    assert.deepEqual(replayed,created);assert.equal((await readdir(f.baseDirectory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).length,1);
    const staged=join(created.root,'.studio/staging/other-process.json');await writeFile(staged,'still owned');
    await f.store.open(created.root);assert.equal(await readFile(staged,'utf8'),'still owned');
  }finally{await f.close();}
});
