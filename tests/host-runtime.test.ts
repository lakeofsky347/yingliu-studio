import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppBackend} from '../src/app/backend.ts';
import {VideoRenderer,detectEnvironment} from '../src/host/renderer.ts';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {candidateHash,contentHash} from '../src/agent/repository.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
const providers={listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No provider allowed');}};
const credentials={async get(){return undefined;},async set(){},async delete(){}};
const originalPreview=VideoRenderer.prototype.preview,originalAudio=VideoRenderer.prototype.audioPreview;
before(()=>{VideoRenderer.prototype.preview=async()=> 'http://localhost:1/';VideoRenderer.prototype.audioPreview=async()=>null;});
after(()=>{VideoRenderer.prototype.preview=originalPreview;VideoRenderer.prototype.audioPreview=originalAudio;});
async function fixture(){const dataDirectory=await mkdtemp(join(tmpdir(),'studio-host-runtime-'));const backend=new AppBackend({dataDirectory,providers,credentials});return {backend,dataDirectory,async close(){await backend.dispose();await rm(dataDirectory,{recursive:true,force:true});}};}

test('operation replays preserve original receipts after undo, reject changed payloads and recover create',async()=>{
 const f=await fixture();try{
  const created=await f.backend.call<StudioSnapshot>('create',{title:'幂等新工程',operationId:'create-fixed'}),id=created.project!.id;
  assert.equal((await f.backend.call<StudioSnapshot>('create',{title:'幂等新工程',operationId:'create-fixed'})).project!.id,id);
  const input={projectId:id,expectedRevision:0,title:'已提交',operationId:'edit-fixed'};
  const edited=await f.backend.call<StudioSnapshot>('apply',input);assert.equal(edited.project!.revision,1);
  await f.backend.call('undo',{projectId:id,expectedRevision:1});
  const replay=await f.backend.call<StudioSnapshot>('apply',input);assert.equal(replay.project!.revision,1);assert.equal(replay.project!.title,'已提交');
  assert.equal((await f.backend.call<StudioSnapshot>('current',{projectId:id})).project!.revision,2);
  assert.equal((await f.backend.operationReceipt(id,'edit-fixed'))!.committedRevision,1);
  const wrong=await f.backend.route('apply',{...input,title:'changed'});assert.equal(wrong.ok,false);if(!wrong.ok)assert.equal(wrong.error.code,'OPERATION_CONFLICT');
  assert.equal(await f.backend.operationReceipt('missing-project','missing'),undefined);
 }finally{await f.close();}
});

test('independent backends refresh authoritative HEAD and atomic imports never publish partial references',async()=>{
 const f=await fixture();let second:AppBackend|undefined;try{
  const first=await f.backend.call<StudioSnapshot>('create',{title:'共享工程'}),id=first.project!.id;
  second=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials});await second.call('current',{projectId:id});
  await f.backend.call('apply',{projectId:id,expectedRevision:0,title:'跨进程更新',operationId:'cross-process'});
  assert.equal((await second.call<StudioSnapshot>('current',{projectId:id})).project!.title,'跨进程更新');
  const stale=await second.route('apply',{projectId:id,expectedRevision:0,title:'不允许覆盖'});assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'REVISION_CONFLICT');
  const failed=await second.route('applyOperation',{projectId:id,expectedRevision:1,title:'不允许部分提交',imports:[{text:'first',name:'first'},{dataBase64:'invalid!',mime:'image/png'}]});assert.equal(failed.ok,false);
  const current=(await second.call<StudioSnapshot>('current',{projectId:id})).project!;assert.equal(current.revision,1);assert.equal(current.assets.length,0);assert.equal(current.title,'跨进程更新');
 }finally{await second?.dispose();await f.close();}
});

test('late or missing task cancellation never aborts the owned task',async()=>{
 const f=await fixture(),previous=VideoRenderer.prototype.check;let aborted=false;
 VideoRenderer.prototype.check=async(_root,_project,_settings,signal)=>new Promise((_,reject)=>{signal?.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});
 try{
  const first=await f.backend.call<StudioSnapshot>('create',{title:'取消隔离'}),id=first.project!.id;
  const running=await f.backend.call<StudioSnapshot>('preview',{projectId:id});
  for(const input of [{projectId:id},{projectId:id,expectedTaskId:'obsolete'}]){const result=await f.backend.route('cancel',input);assert.equal(result.ok,false);assert.equal(aborted,false);}
  await f.backend.call('cancel',{projectId:id,expectedTaskId:running.task!.id});assert.equal(aborted,true);
 }finally{VideoRenderer.prototype.check=previous;await f.close();}
});

test('candidate syntax and real browser validation bind immutable evidence to source hashes',{skip:!detectEnvironment().browserAvailable,timeout:60000},async()=>{
 const f=await fixture();try{
  const project=createProject('候选验收');project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=4;project.target={width:160,height:90,fps:{num:4,den:1},audioMode:'none'};project.targetDuration=1;
  const first=await f.backend.call<StudioSnapshot>('create',{project}),source=defaultSceneSource(),candidate={project:first.project!,sources:{[project.shots[0]!.id]:source}};
  const valid=await f.backend.validateCandidate(project.id,candidate);assert.equal(valid.status,'passed');assert.equal(valid.candidateHash,candidateHash(candidate));assert.ok(valid.frames.length>=2);
  const invalid=await f.backend.validateCandidate(project.id,{...candidate,sources:{[project.shots[0]!.id]:{...source,js:'export function render( {'}}});assert.equal(invalid.status,'failed');assert.equal(invalid.checks.find(item=>item.id==='syntax')?.status,'failed');assert.notEqual(valid.candidateHash,invalid.candidateHash);
  const tampered=await f.backend.route('apply',{projectId:project.id,expectedRevision:0,project:{...candidate.project,title:'receipt mismatch'},sources:Object.entries(candidate.sources).map(([shotId,source])=>({shotId,source})),validationId:valid.id});assert.equal(tampered.ok,false);
  const applied=await f.backend.call<StudioSnapshot>('apply',{projectId:project.id,expectedRevision:0,project:candidate.project,sources:Object.entries(candidate.sources).map(([shotId,source])=>({shotId,source})),validationId:valid.id,operation:{id:'validated-commit',payloadHash:contentHash(candidate)}});assert.equal(applied.project!.revision,1);
  assert.ok((await readFile(join(first.root!,'.studio/state.sqlite'))).length>0);
 }finally{await f.close();}
});

test('concurrent application registries merge project registration and pinned source reads survive later edits',async()=>{
 const f=await fixture(),second=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials});try{
  await Promise.all([f.backend.call('list'),second.call('list')]);
  const [a,b]=await Promise.all([f.backend.call<StudioSnapshot>('create',{title:'并行 A',operationId:'register-a'}),second.call<StudioSnapshot>('create',{title:'并行 B',operationId:'register-b'})]);
  const list=await f.backend.call<{projects:{id:string}[]}>('list');assert.deepEqual(new Set(list.projects.map(project=>project.id)),new Set([a.project!.id,b.project!.id]));
  const shotId=a.project!.shots[0]!.id,source=await f.backend.call('source',{projectId:a.project!.id,shotId,revision:0});
  await Promise.all([f.backend.call('apply',{projectId:a.project!.id,expectedRevision:0,title:'A 修改',sources:[{shotId,source:{...defaultSceneSource(),css:'.changed{}'}}]}),second.call('apply',{projectId:b.project!.id,expectedRevision:0,title:'B 修改'})]);
  assert.deepEqual(await second.call('source',{projectId:a.project!.id,shotId,revision:0}),source);
  assert.equal((await f.backend.call<{projects:{id:string;title:string}[]}>('list')).projects.find(project=>project.id===b.project!.id)!.title,'B 修改');
 }finally{await second.dispose();await f.close();}
});

test('audio candidates are fully decoded and mixed rather than accepted from file existence',{skip:!detectEnvironment().browserAvailable||!detectEnvironment().ffmpegAvailable||!detectEnvironment().ffprobeAvailable,timeout:60000},async()=>{
 const f=await fixture();try{
  const wave=Buffer.alloc(44+48000*4);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(192000,28);wave.writeUInt16LE(4,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);
  for(const [index,bytes] of [wave,Buffer.from('not decodable audio')].entries()){
    const project=createProject('音频候选 '+index);project.shots=project.shots.slice(0,1);project.shotOrder=project.shots.map(shot=>shot.id);project.shots[0]!.durationFrames=4;project.target={width:160,height:90,fps:{num:4,den:1},audioMode:'mixed'};project.targetDuration=1;
    project.assets=[{id:'voice',kind:'audio',name:'本地合成验收',description:'fixture',path:'assets/voice.wav',mime:'audio/wav',duration:1,sampleRate:48000,channels:2}];project.audioClips=[{id:'voice-clip',assetId:'voice',role:'voice',shotId:project.shots[0]!.id,startSeconds:0,trimStart:0,trimEnd:1,volume:1,fadeIn:0,fadeOut:0}];
    const first=await f.backend.call<StudioSnapshot>('create',{project,assetFiles:[{path:'assets/voice.wav',dataBase64:bytes.toString('base64')}]}),candidate={project:first.project!,sources:{[project.shots[0]!.id]:defaultSceneSource()}};
    const receipt=await f.backend.validateCandidate(project.id,candidate);assert.equal(receipt.checks.find(check=>check.id==='audio-decode-mix')?.status,index===0?'passed':'failed');assert.equal(receipt.status,index===0?'passed':'failed');
  }
 }finally{await f.close();}
});

test('legacy supplier intents survive failed requests and refuse duplicate submissions after reopen',async()=>{
 const f=await fixture();const {AppSceneGenerator}=await import('../src/host/generator.ts');const generate=AppSceneGenerator.prototype.scene;let calls=0;
 AppSceneGenerator.prototype.scene=async()=>{calls++;throw new Error('fixture lost supplier response');};
 let reopened:AppBackend|undefined;
 try{
  const first=await f.backend.call<StudioSnapshot>('create',{title:'未决供应商请求'}),input={projectId:first.project!.id,expectedRevision:0,operationId:'supplier-once',kind:'scenes',provider:'fixture',model:'fixture'};
  await f.backend.call('generate',input);for(let i=0;i<30;i++){if((await f.backend.call<StudioSnapshot>('current',{projectId:first.project!.id})).task?.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}await f.backend.dispose();
  reopened=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials});
  const replay=await reopened.route('generate',input);assert.equal(replay.ok,false);if(!replay.ok)assert.equal(replay.error.code,'OPERATION_UNRESOLVED');assert.equal(calls,1);
  const changed=await reopened.route('generate',{...input,model:'different'});assert.equal(changed.ok,false);if(!changed.ok)assert.equal(changed.error.code,'OPERATION_CONFLICT');assert.equal(calls,1);
  assert.equal((await reopened.operationIntent(first.project!.id,input.operationId))?.kind,'generate');
 }finally{AppSceneGenerator.prototype.scene=generate;await reopened?.dispose();await f.close();}
});

test('supplier intent reservation serializes independent database workers before any external work',async()=>{
 const {reserveExternalOperation,readExternalOperation}=await import('../src/host/operation-intents.ts'),directory=await mkdtemp(join(tmpdir(),'studio-intent-claim-')),file=join(directory,'state.sqlite'),operation={id:'shared-submit',payloadHash:contentHash({input:'local fixture'})};
 try{
  const results=await Promise.allSettled([reserveExternalOperation(file,operation,'generate'),reserveExternalOperation(file,operation,'generate')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'OPERATION_UNRESOLVED');
  assert.equal((await readExternalOperation(file,operation.id))!.payloadHash,operation.payloadHash);
 }finally{await rm(directory,{recursive:true,force:true});}
});
