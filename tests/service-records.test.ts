import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {AgentDatabase} from '../src/agent/database.ts';
import {DurableServiceRecords} from '../src/jobs/durable-records.ts';
import {startMediaGateway} from './media-gateway.ts';

test('two real OS processes share one media intent and submit exactly once',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'media-process-')),gateway=await startMediaGateway({imageBase64:true});const children:ChildProcess[]=[];
  const exited=(child:ChildProcess)=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise<void>(resolve=>{child.once('exit',()=>resolve());});
  t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill();await Promise.race([Promise.all(children.map(exited)),new Promise(resolve=>setTimeout(resolve,5000))]);await gateway.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const launch=()=>{const child=fork(new URL('./fixtures/service-ledger-worker.mjs',import.meta.url),[directory,gateway.url],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});children.push(child);let errors='';child.stderr?.on('data',data=>{errors+=String(data);});let ready!:()=>void;const begun=new Promise<void>(resolve=>{ready=resolve;});const result=new Promise<{id:string;phase:string}>((resolve,reject)=>{child.on('message',(value:{ready?:boolean;error?:string;id:string;phase:string})=>{if(value.ready)ready();else if(value.error)reject(new Error(value.error));else resolve(value);});child.on('error',reject);child.on('exit',code=>{if(code)reject(new Error(errors||'worker failed'));});});return {child,begun,result};};
  const a=launch(),b=launch();await Promise.all([a.begun,b.begun]);a.child.send('go');b.child.send('go');  const [left,right]=await Promise.all([a.result,b.result]);assert.equal(left.id,right.id);assert.equal(left.phase,'ready');assert.equal(gateway.requests.filter(request=>request.method==='POST'&&request.path==='/v1/images/generations').length,1);
  await Promise.race([Promise.all(children.map(exited)),new Promise(resolve=>setTimeout(resolve,8000))]);
  for(const child of children)if(child.exitCode===null)child.kill();
  await Promise.all(children.map(exited));
});

test('expired service leases reject late saves and stale-generation stop requests',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'service-fence-')),databasePath=join(directory,'.studio','state.sqlite'),a=new DurableServiceRecords<{id:string;projectId:string;result?:string}>(directory,'media',async()=>databasePath),b=new DurableServiceRecords<{id:string;projectId:string;result?:string}>(directory,'media',async()=>databasePath),database=new AgentDatabase(databasePath);
  t.after(async()=>{await a.close();await b.close();await database.close();await rm(directory,{recursive:true,force:true});});await a.create({id:'task',projectId:'film'},'op','hash','pending');const first=await a.claim('task','film');assert.ok(first);assert.equal(await b.claim('task','film'),undefined);
  await database.transaction([{sql:"UPDATE service_records SET lease_until=0 WHERE kind='media' AND id='task'"}]);const second=await b.claim('task','film');assert.ok(second);assert.equal(second.generation,first.generation+1);await assert.rejects(a.save({...first.value,result:'late'},'ready'),{code:'TASK_LEASE_LOST'});await assert.rejects(a.stop('task','film',first.generation),{code:'TASK_LEASE_LOST'});await b.save({...second.value,result:'accepted'},'ready');assert.equal((await b.read('task','film'))?.value.result,'accepted');
});

test('project ledger repairs an interrupted application-index update without duplicating the record',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'service-index-recovery-')),databasePath=join(directory,'.studio','state.sqlite'),a=new DurableServiceRecords<{id:string;projectId:string}>(directory,'media',async()=>databasePath);let b:typeof a|undefined;
  t.after(async()=>{await a.close();await b?.close();await rm(directory,{recursive:true,force:true});});await a.create({id:'known-task',projectId:'film'},'stable-operation','hash','pending');await a.close();
  const index=new AgentDatabase(join(directory,'agent-service-index.sqlite'));await index.transaction([{sql:'DELETE FROM service_locations'}]);await index.close();b=new DurableServiceRecords(directory,'media',async()=>databasePath);assert.equal(await b.read('known-task'),undefined);assert.equal((await b.list('film')).length,1);assert.equal((await b.read('known-task'))?.operationId,'stable-operation');
});
