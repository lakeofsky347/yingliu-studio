import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {AgentDatabase} from '../src/agent/database.ts';
import {AgentRepository,candidateHash} from '../src/agent/repository.ts';
import {AgentRuntime} from '../src/agent/runtime.ts';
import type {AgentCandidate,AgentRuntimePorts,AgentScope,ValidationReceipt} from '../src/agent/contracts.ts';

const rootScope:AgentScope={shotIds:['*'],writeFields:['*'],capabilities:['*']};
const passed=(candidate:AgentCandidate):ValidationReceipt=>({id:randomUUID(),candidateHash:candidate.hash,baseRevision:candidate.payload.baseRevision,status:'passed',checks:['structure','syntax','assets','runtime'].map(id=>({id,status:'passed'})),frames:[{frame:0,sha256:'fixture-frame'}],createdAt:new Date().toISOString(),validatorVersion:'test-contract-only'});
async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'studio-agents-')),file=join(dir,'state.sqlite'),db=new AgentDatabase(file),repo=new AgentRepository(db,'project-test');
  const session=await repo.createSession({id:'root-session',name:'导演'}),root=await repo.createTask({id:'root-task',sessionId:session.id,goal:'制作影片',scope:rootScope}),lease=await repo.claimTask(root.id,'test-root');
  const project=createProject('测试影片');project.id='project-test';const sources=Object.fromEntries(project.shots.map(shot=>[shot.id,defaultSceneSource()]));
  const scope:AgentScope={shotIds:[project.shots[0]!.id],writeFields:['source'],capabilities:['code']};
  t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  return {dir,file,db,repo,session,root,lease,project,sources,scope};
}
test('agent sessions persist separate conversations and use version CAS',async t=>{
  const f=await fixture(t);await f.repo.saveSessionData(f.session.id,{messages:['A']},f.session.version);
  await assert.rejects(f.repo.saveSessionData(f.session.id,{messages:['stale']},f.session.version),{code:'DB_CONFLICT'});
  const other=await f.repo.createSession({name:'另一个会话',data:{messages:['B']}});assert.deepEqual((await f.repo.getSession(f.session.id)).data,{messages:['A']});assert.deepEqual(other.data,{messages:['B']});
  await assert.rejects(f.repo.createTask({sessionId:f.session.id,goal:'重复回合',scope:rootScope}));
});
test('separate database workers admit one lease and fence an expired executor',async t=>{
  const f=await fixture(t),db2=new AgentDatabase(f.file),repo2=new AgentRepository(db2,'project-test');t.after(()=>db2.close());
  await assert.rejects(repo2.claimTask(f.root.id,'other-process'),{code:'DB_CONFLICT'});
  const newer=await repo2.claimTask(f.root.id,'other-process',f.lease.leaseExpiresAt+1);assert.ok(newer.generation>f.lease.generation);
  await assert.rejects(f.repo.assertLease(f.lease),{code:'LEASE_LOST'});
  await assert.rejects(f.repo.beginOperation(f.lease,'late-write',{value:1}),{code:'LEASE_LOST'});
});
test('root budgets include all children and repeated tool calls',async t=>{
  const f=await fixture(t);await f.repo.reserveBudget(f.lease,{modelCalls:63,toolCalls:127});
  await f.repo.reserveBudget(f.lease,{modelCalls:1,toolCalls:1});await assert.rejects(f.repo.reserveBudget(f.lease,{modelCalls:1}),{code:'DB_CONFLICT'});
  const budget=await f.repo.getBudget(f.root.id);assert.equal(budget.modelCalls,64);assert.equal(budget.toolCalls,128);
});
test('actual worker loop reads, executes a scoped candidate and waits for parent acceptance',async t=>{
  const f=await fixture(t),calls:string[]=[],rounds=new Map<string,number>();
  const ports:AgentRuntimePorts={
    async context(task){return {projectId:task.projectId,shots:[{id:f.project.shots[0]!.id,title:'授权镜头'}]};},
    async text({task,messages}){calls.push('model');assert.ok(messages.every(message=>!message.content.includes('unrelated-parent-transcript')));const n=rounds.get(task.id)??0;rounds.set(task.id,n+1);return JSON.stringify(n===0?{type:'read',query:{shotIds:f.scope.shotIds,fields:['source']}}:n===1?{type:'execute',tool:'code',shotId:f.scope.shotIds[0],input:{source:{html:'<main>新标题</main>',css:'',js:'export function render(ctx) {}'}}}:{type:'submit',summary:'完成授权镜头'});},
    async inspect(){calls.push('inspect');return {source:'已读取指定源码'};},
    async execute(_task,action){calls.push('execute');const payload={project:structuredClone(f.project),sources:{...f.sources,[action.shotId!]:action.input.source as typeof f.sources[string]},baseRevision:f.project.revision};return {summary:'源码候选已保存',candidate:payload};},
    async validate(_task,candidate){calls.push('validate');assert.equal(candidate.hash,candidateHash(candidate.payload));return passed(candidate);},
  };
  const runtime=new AgentRuntime(f.repo,ports);t.after(()=>runtime.dispose());
  const request={parentTaskId:f.root.id,parentLease:f.lease,operationId:'delegate-once',mode:'subagent' as const,goal:'更新一个镜头',role:'scene' as const,scope:f.scope,data:{baseline:{project:f.project,sources:f.sources},unrelated:'unrelated-parent-transcript'}};
  const task=await runtime.delegate(request);assert.equal((await runtime.delegate(request)).id,task.id);
  const done=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(done.status,'awaiting-acceptance',done.error);assert.deepEqual(calls,['model','inspect','model','execute','model','validate']);
  const result=await runtime.result(task.id);assert.ok(result.candidate);assert.equal((await runtime.accept(f.lease,result.candidate!.id)).status,'accepted');assert.equal((await f.repo.getTask(task.id)).status,'succeeded');assert.equal((await f.repo.getSession<{archived:boolean}>(task.sessionId)).data.archived,true);await assert.rejects(f.repo.createTask({sessionId:task.sessionId,parentTaskId:f.root.id,goal:'不可复用一次性成员',scope:f.scope}),{code:'SESSION_ARCHIVED'});
  assert.equal((await f.repo.getBudget(f.root.id)).children,1);assert.equal((await f.repo.getBudget(f.root.id)).modelCalls,3);
});
test('worker rejects cross-shot writes even when a port returns a successful result',async t=>{
  const f=await fixture(t);let requests=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'授权第一个镜头'};},async text(){requests++;return JSON.stringify({type:'execute',tool:'code',shotId:f.scope.shotIds[0],input:{}});},async inspect(){return {};},async execute(){const project=structuredClone(f.project);project.shots[1]!.title='越界';return {summary:'看似成功',candidate:{project,sources:f.sources,baseRevision:f.project.revision}};},async validate(){throw new Error('must not validate out of scope');}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'修改单镜头',scope:f.scope,data:{baseline:{project:f.project,sources:f.sources}}});const done=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(done.status,'failed');assert.match(done.error??'',/范围/);assert.equal(requests,1);assert.equal((await f.repo.listCandidates(task.id)).length,0);
});
test('uncertain remote execution is reconciled rather than resubmitted after retry',async t=>{
  const f=await fixture(t);let executions=0,models=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'固定输入'};},async text(){models++;return JSON.stringify({type:'execute',tool:'code',shotId:f.scope.shotIds[0],input:{}});},async inspect(){return {};},async execute(){executions++;throw new Error('response lost after submission');},async validate(){throw new Error('unreachable');}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'代码候选',scope:f.scope,data:{baseline:{project:f.project,sources:f.sources}}});const blocked=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(blocked.status,'blocked');
  const retried=await runtime.run(task.id);assert.equal(retried.status,'blocked');assert.equal(retried.checkpoint,'RECONCILIATION_REQUIRED');assert.equal(executions,1);assert.equal(models,1);
});
test('candidate evidence needs mandatory deterministic checks and parent-only acceptance',async t=>{
  const f=await fixture(t),session=await f.repo.createSession({kind:'subagent',parentSessionId:f.session.id}),task=await f.repo.createTask({sessionId:session.id,parentTaskId:f.root.id,goal:'检查',scope:{shotIds:f.scope.shotIds,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}}),lease=await f.repo.claimTask(task.id,'child');
  const candidate=await f.repo.submitCandidate(lease,{project:f.project,sources:f.sources,baseRevision:f.project.revision},'检查结果');
  await assert.rejects(f.repo.recordValidation(lease,candidate.id,{...passed(candidate),checks:[{id:'model-says-pass',status:'passed'}]}),{code:'VALIDATION_INVALID'});
  await f.repo.recordValidation(lease,candidate.id,passed(candidate));await f.repo.transition(lease,'awaiting-acceptance',{candidateId:candidate.id});
  const other=await f.repo.createSession(),otherTask=await f.repo.createTask({sessionId:other.id,goal:'其他根任务',scope:rootScope}),otherLease=await f.repo.claimTask(otherTask.id,'other');await assert.rejects(f.repo.acceptCandidate(otherLease,candidate.id),{code:'ACCEPTANCE_DENIED'});
  await f.repo.acceptCandidate(f.lease,candidate.id);assert.equal((await f.repo.getTask(task.id)).status,'succeeded');
});
test('project-wide child admission is capped at two across repository connections',async t=>{
  const f=await fixture(t),db2=new AgentDatabase(f.file),other=new AgentRepository(db2,'project-test');t.after(()=>db2.close());
  const children=[];for(let i=0;i<3;i++){const session=await f.repo.createSession({kind:'subagent',parentSessionId:f.session.id});children.push(await f.repo.createTask({sessionId:session.id,parentTaskId:f.root.id,goal:'并发'+i,scope:f.scope}));}
  const attempts=await Promise.allSettled(children.map((task,index)=>(index%2?other:f.repo).claimTask(task.id,'worker-'+index)));
  assert.equal(attempts.filter(value=>value.status==='fulfilled').length,2);assert.equal(attempts.filter(value=>value.status==='rejected').length,1);
  const leases=attempts.flatMap(value=>value.status==='fulfilled'?[value.value]:[]);await f.repo.transition(leases[0]!,'paused');
  const queued=children.find((_,index)=>attempts[index]!.status==='rejected')!;assert.equal((await other.claimTask(queued.id,'third-worker')).taskId,queued.id);
});
test('pause and resume require current generation, revoke descendants, and retain cumulative budgets',async t=>{
  const f=await fixture(t),session=await f.repo.createSession({kind:'subagent',parentSessionId:f.session.id}),task=await f.repo.createTask({sessionId:session.id,parentTaskId:f.root.id,goal:'检查',scope:{shotIds:f.scope.shotIds,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}}),lease=await f.repo.claimTask(task.id,'child');
  const candidate=await f.repo.submitCandidate(lease,{project:f.project,sources:f.sources,baseRevision:f.project.revision},'等待检查');
  await f.db.transaction([{sql:'UPDATE agent_tasks SET last_heartbeat=? WHERE id=?',params:[Date.now()-1000,task.id]}]);
  await f.repo.reserveBudget(lease,{modelCalls:2});
  const paused=await f.repo.controlTask(f.root.id,'pause',{sessionId:f.session.id,expectedGeneration:f.lease.generation});
  assert.equal((await f.repo.getTask(task.id)).status,'paused');assert.equal((await f.repo.getCandidate(candidate.id)).status,'rejected');assert.ok((await f.repo.getBudget(f.root.id)).activeMs>=1000);
  await assert.rejects(f.repo.recordValidation(lease,candidate.id,passed(candidate)),{code:'DB_CONFLICT'});
  await assert.rejects(f.repo.controlTask(f.root.id,'resume',{sessionId:f.session.id,expectedGeneration:f.lease.generation}),{code:'GENERATION_CONFLICT'});
  await f.repo.controlTask(f.root.id,'resume',{sessionId:f.session.id,expectedGeneration:paused.generation});const rootLease=await f.repo.claimTask(f.root.id,'new-root');
  await assert.rejects(f.repo.claimTask(task.id,'stale-child'),{code:'DB_CONFLICT'});
  const child=await f.repo.getTask(task.id);await f.repo.controlTask(task.id,'resume',{sessionId:f.session.id,expectedGeneration:child.generation});const next=await f.repo.claimTask(task.id,'new-child');await f.repo.assertLease(next);await f.repo.assertLease(rootLease);
  assert.equal((await f.repo.getBudget(f.root.id)).modelCalls,2);
});
test('failed validation supplies repair evidence without extending four decision rounds',async t=>{
  const f=await fixture(t);let calls=0,validations=0,executions=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'更新一个镜头'};},async text({messages}){const n=calls++;if(n===2)assert.match(messages[1]!.content,/syntax/);return JSON.stringify(n%2===0?{type:'execute',tool:'code',shotId:f.scope.shotIds[0],input:{version:n}}:{type:'submit',summary:'候选完成'});},async inspect(){return {};},async execute(task,action){executions++;const previous=(task.data?.runtime as {candidate?:AgentCandidate['payload']}|undefined)?.candidate;const candidate=structuredClone(previous??{project:f.project,sources:f.sources,baseRevision:f.project.revision});candidate.sources[action.shotId!]={html:'<main>'+action.input.version+'</main>',css:'',js:'export function render(ctx) {}'};return {summary:'写入候选',candidate};},async validate(_task,candidate){validations++;const receipt=passed(candidate);if(validations===1){receipt.status='failed';receipt.checks=receipt.checks.map(check=>check.id==='syntax'?{...check,status:'failed',message:'请修复生成语法'}:check);}return receipt;}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'修复语法',scope:f.scope,data:{baseline:{project:f.project,sources:f.sources}}});const done=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(done.status,'awaiting-acceptance',done.error);assert.equal(calls,4);assert.equal(validations,2);assert.equal(executions,2);assert.equal((await f.repo.listCandidates(task.id)).filter(candidate=>candidate.status==='rejected').length,1);
});
test('repeated identical execute intent reuses its operation receipt',async t=>{
  const f=await fixture(t);let calls=0,executions=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'固定任务'};},async text(){return JSON.stringify(calls++<2?{type:'execute',tool:'code',shotId:f.scope.shotIds[0],input:{source:'same-intent'}}:{type:'submit',summary:'完成'});},async inspect(){return {};},async execute(){executions++;return {summary:'已经执行',candidate:{project:f.project,sources:{...f.sources,[f.scope.shotIds[0]!]:{html:'新画面',css:'',js:''}},baseRevision:f.project.revision}};},async validate(_task,candidate){return passed(candidate);}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'只执行一次',scope:f.scope,data:{baseline:{project:f.project,sources:f.sources}}});const done=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(done.status,'awaiting-acceptance',done.error);assert.equal(executions,1);
});
test('read-only member cannot finish with a bare model assertion',async t=>{
  const f=await fixture(t);let validations=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'检查镜头'};},async text(){return JSON.stringify({type:'submit',summary:'看起来没有问题',evidence:{status:'passed'}});},async inspect(){return {};},async execute(){throw new Error('no write');},async validate(_task,candidate){validations++;return passed(candidate);}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'只读审查',scope:{...f.scope,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}});const done=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(done.status,'blocked');assert.equal(done.checkpoint,'EVIDENCE_REQUIRED');assert.equal(validations,0);
});
test('agent and workflow entry points share one durable session activity slot',async t=>{
  const f=await fixture(t),session=await f.repo.createSession({name:'工作流占用会话'});
  await f.db.transaction([{sql:"INSERT INTO session_activity(session_id,kind,task_id) VALUES(?,'workflow','workflow-running')",params:[session.id]}]);
  await assert.rejects(f.repo.createTask({sessionId:session.id,goal:'冲突导演回合',scope:rootScope}),{code:'DB_CONFLICT'});
  assert.equal((await f.repo.listTasks({sessionId:session.id})).length,0);
  await f.db.transaction([{sql:"DELETE FROM session_activity WHERE session_id=? AND kind='workflow'",params:[session.id]}]);
  const task=await f.repo.createTask({sessionId:session.id,goal:'工作流完成后开始',scope:rootScope}),lease=await f.repo.claimTask(task.id,'director');
  await assert.rejects(f.db.transaction([{sql:"INSERT INTO session_activity(session_id,kind,task_id) VALUES(?,'workflow','next-workflow') ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id WHERE session_activity.kind='workflow' AND session_activity.task_id=excluded.task_id",params:[session.id],expectChanges:1}]),{code:'DB_CONFLICT'});
  await f.repo.transition(lease,'succeeded');assert.equal((await f.db.query('SELECT * FROM session_activity WHERE session_id=?',[session.id])).length,0);
});
test('root completion waits for children and recovery rebinds only inactive candidate grants',async t=>{
  const f=await fixture(t),session=await f.repo.createSession({kind:'subagent',parentSessionId:f.session.id}),task=await f.repo.createTask({sessionId:session.id,parentTaskId:f.root.id,goal:'待验收候选',scope:{shotIds:f.scope.shotIds,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}}),lease=await f.repo.claimTask(task.id,'child');
  const candidate=await f.repo.submitCandidate(lease,{project:f.project,sources:f.sources,baseRevision:f.project.revision},'检查结论');await f.repo.recordValidation(lease,candidate.id,passed(candidate));await f.repo.transition(lease,'awaiting-acceptance',{candidateId:candidate.id});
  await assert.rejects(f.repo.assertCanComplete(f.lease),{code:'CHILDREN_PENDING'});await assert.rejects(f.repo.transition(f.lease,'succeeded'),{code:'CHILDREN_PENDING'});assert.equal((await f.repo.getTask(f.root.id)).status,'preflight');
  await f.repo.transition(f.lease,'blocked',{error:'等待子任务验收'});const parent=await f.repo.getTask(f.root.id);await f.repo.controlTask(parent.id,'resume',{sessionId:f.session.id,expectedGeneration:parent.generation});const resumed=await f.repo.claimTask(parent.id,'new-root');
  assert.equal((await f.repo.acceptCandidate(resumed,candidate.id)).status,'accepted');await f.repo.assertCanComplete(resumed);await f.repo.transition(resumed,'succeeded');assert.equal((await f.repo.getTask(parent.id)).status,'succeeded');
});
test('child cancellation fences both the root lease and the target generation',async t=>{
  const f=await fixture(t),session=await f.repo.createSession({kind:'subagent',parentSessionId:f.session.id}),child=await f.repo.createTask({sessionId:session.id,parentTaskId:f.root.id,goal:'不许旧调用取消',scope:f.scope}),lease=await f.repo.claimTask(child.id,'child');
  await assert.rejects(f.repo.cancelChild(f.lease,child.id,lease.generation-1),{code:'GENERATION_CONFLICT'});
  await f.repo.transition(f.lease,'blocked');const parent=await f.repo.getTask(f.root.id);await f.repo.controlTask(parent.id,'resume',{sessionId:f.session.id,expectedGeneration:parent.generation});const current=await f.repo.claimTask(parent.id,'current-parent');
  await assert.rejects(f.repo.cancelChild(f.lease,child.id,lease.generation),{code:'LEASE_LOST'});assert.equal((await f.repo.getTask(child.id)).status,'preflight');
  await assert.rejects(f.repo.assertLease({...current,projectId:'other-project'}),{code:'LEASE_LOST'});
  const cancelled=await f.repo.cancelChild(current,child.id,lease.generation);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.generation,lease.generation+1);assert.equal((await f.db.query('SELECT * FROM session_activity WHERE session_id=?',[session.id])).length,0);
});
test('retry retains the four-round planning ceiling and does not invoke extra models',async t=>{
  const f=await fixture(t);let calls=0;
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'只读检查'};},async text(){return JSON.stringify({type:'read',query:{offset:calls++}});},async inspect(_task,query){return {page:query.offset};},async execute(){throw new Error('unexpected');},async validate(){throw new Error('unexpected');}});t.after(()=>runtime.dispose());
  const task=await runtime.delegate({parentTaskId:f.root.id,parentLease:f.lease,mode:'subagent',goal:'有限规划',scope:{...f.scope,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}});const blocked=await runtime.wait(task.id,{timeoutMs:5000});assert.equal(blocked.checkpoint,'round-limit');assert.equal(calls,4);
  const retried=await runtime.run(task.id);assert.equal(retried.checkpoint,'round-limit');assert.equal(calls,4);assert.equal((await f.repo.getBudget(f.root.id)).modelCalls,4);
});
test('task data updates from one lease use a version CAS instead of overwriting each other',async t=>{
  const f=await fixture(t),original=f.repo.assertLease.bind(f.repo);let arrived=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  f.repo.assertLease=async token=>{const task=await original(token);if(++arrived===2)release();await gate;return task;};
  const result=await Promise.allSettled([f.repo.transition(f.lease,'planning',{data:{one:'first'}}),f.repo.transition(f.lease,'executing',{data:{two:'second'}})]);f.repo.assertLease=original;
  assert.equal(result.filter(item=>item.status==='fulfilled').length,1);const failure=result.find(item=>item.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.code,'DB_CONFLICT');
  const task=await f.repo.getTask(f.root.id);assert.notEqual(Boolean(task.data?.one),Boolean(task.data?.two));
});
test('team reuse injects only compact accepted memory and progress events are coalesced',async t=>{
  const f=await fixture(t),rounds=new Map<string,number>(),contexts:string[]=[];
  const runtime=new AgentRuntime(f.repo,{async context(){return {summary:'当前任务包'};},async text({task,messages}){const round=rounds.get(task.id)??0;rounds.set(task.id,round+1);if(round===0)contexts.push(messages[0]!.content);return JSON.stringify(round===0?{type:'read',query:{shotIds:f.scope.shotIds}}:{type:'submit',summary:'已验收的构图经验',evidence:{status:'passed',notes:['已读取指定镜头']}});},async inspect(){return {composition:'居中'};},async execute(){throw new Error('unexpected');},async validate(_task,candidate){return passed(candidate);}});t.after(()=>runtime.dispose());
  const request={parentTaskId:f.root.id,parentLease:f.lease,mode:'team' as const,goal:'审查构图',scope:{shotIds:f.scope.shotIds,writeFields:[],capabilities:[]},data:{baseline:{project:f.project,sources:f.sources}}};
  const first=await runtime.delegate({...request,operationId:'team-first'});await runtime.wait(first.id,{timeoutMs:5000});const result=await runtime.result(first.id);await runtime.accept(f.lease,result.candidate!.id);
  const session=await f.repo.getSession(first.sessionId);assert.ok(JSON.stringify(session.data).length<=4000);assert.match(JSON.stringify(session.data),/acceptedMemory/);
  const second=await runtime.delegate({...request,sessionId:first.sessionId,operationId:'team-second'});await runtime.wait(second.id,{timeoutMs:5000});assert.equal(contexts.length,2);assert.doesNotMatch(contexts[0]!,/已验收的构图经验/);assert.match(contexts[1]!,/已验收的构图经验/);
  assert.equal((await f.repo.getOperation(first.id+':read:0'))?.status,'complete');const all=await f.repo.messages(first.id,{includeProgress:true});assert.equal(all.filter(message=>message.kind==='progress').length,1);assert.ok((await f.repo.messages(first.id)).every(message=>message.kind!=='progress'));assert.ok(all.some(message=>message.kind==='decision'));assert.ok(all.some(message=>message.kind==='result'));
});
