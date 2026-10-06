import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioController } from '../src/client/controller.ts';
import { createProject } from '../src/core/index.ts';
import type { StudioApi, StudioSnapshot, VideoProject } from '../src/shared/types.ts';

type Request={endpoint:string;payload:Record<string,unknown>};
function initialSnapshot():StudioSnapshot{
  return {project:createProject('Controller regression'),root:'/tmp/yingliu-controller-regression',task:null,previewUrl:null,previewRevision:null,
    providers:[{id:'custom',name:'用户模型',models:[{id:'test-model',name:'用户模型'}]}],
    environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false},recent:[]};
}
function apiFor(handler:(endpoint:string,payload:Record<string,unknown>)=>Promise<unknown>|unknown):StudioApi{
  return {async call<T>(endpoint:string,payload:unknown={}):Promise<T>{if(endpoint==='history')return {canUndo:false,canRedo:false,entries:[],cursor:0} as T;return await handler(endpoint,payload as Record<string,unknown>) as T;}};
}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}

test('saving local edits uses the server revision, then adopts the authoritative saved revision',async()=>{
  let snapshot=initialSnapshot();const baseRevision=snapshot.project!.revision;const requests:Request[]=[];
  const controller=new StudioController(apiFor(async(endpoint,payload)=>{
    requests.push({endpoint,payload});
    if(endpoint==='save')snapshot={...snapshot,project:{...payload.project as VideoProject,revision:baseRevision+1}};
    return structuredClone(snapshot);
  }));
  await controller.load();controller.edit({...snapshot.project!,title:'手动编辑',revision:baseRevision+25});await controller.flush();
  assert.equal(requests.find(request=>request.endpoint==='save')!.payload.expectedRevision,baseRevision);
  assert.equal(controller.getSnapshot().snapshot!.project!.revision,baseRevision+1);
  assert.equal(controller.getSnapshot().snapshot!.project!.title,'手动编辑');
  await controller.dispose();
});

test('source mutations carry the latest revision and permit an explicit caller revision',async()=>{
  let snapshot=initialSnapshot();const requests:Request[]=[];
  const controller=new StudioController(apiFor(async(endpoint,payload)=>{
    requests.push({endpoint,payload});if(endpoint!=='catalog')snapshot={...snapshot,project:{...snapshot.project!,revision:snapshot.project!.revision+1}};
    return structuredClone(snapshot);
  }));
  await controller.load();const revision=snapshot.project!.revision;
  await controller.saveSource(snapshot.project!.shots[0]!.id,{html:'<main/>',css:'',js:''});
  await controller.restoreSource(snapshot.project!.shots[0]!.id);
  await controller.action('apply',{expectedRevision:77});
  assert.equal(requests.find(request=>request.endpoint==='saveSource')!.payload.expectedRevision,revision);
  assert.equal(requests.find(request=>request.endpoint==='restoreSource')!.payload.expectedRevision,revision+1);
  assert.equal(requests.find(request=>request.endpoint==='apply')!.payload.expectedRevision,77);
  await controller.dispose();
});

test('an edit made while saving is preserved and the next save uses the new server baseline',{timeout:2000},async()=>{
  let snapshot=initialSnapshot();const baseRevision=snapshot.project!.revision;const first=deferred<StudioSnapshot>();const saves:Record<string,unknown>[]=[];
  const controller=new StudioController(apiFor(async(endpoint,payload)=>{
    if(endpoint!=='save')return structuredClone(snapshot);
    saves.push(payload);
    if(saves.length===1)return first.promise;
    snapshot={...snapshot,project:{...payload.project as VideoProject,revision:baseRevision+2}};return structuredClone(snapshot);
  }));
  await controller.load();controller.edit({...snapshot.project!,title:'第一笔编辑',revision:baseRevision+10});const saving=controller.flush();
  controller.edit({...controller.getSnapshot().snapshot!.project!,title:'保存期间的新编辑',revision:baseRevision+20});
  snapshot={...snapshot,project:{...saves[0]!.project as VideoProject,revision:baseRevision+1}};first.resolve(structuredClone(snapshot));await saving;
  assert.equal(saves.length,2);assert.deepEqual(saves.map(request=>request.expectedRevision),[baseRevision,baseRevision+1]);
  assert.equal(controller.getSnapshot().snapshot!.project!.title,'保存期间的新编辑');assert.equal(controller.getSnapshot().saving,false);
  await controller.dispose();
});

test('concurrent flush and disposal terminate after a failed save without recursively retrying',{timeout:2000},async()=>{
  const snapshot=initialSnapshot();const gate=deferred<StudioSnapshot>();let saveCount=0;
  const controller=new StudioController(apiFor(async(endpoint)=>{if(endpoint==='save'){saveCount++;return gate.promise;}return structuredClone(snapshot);}));
  await controller.load();controller.edit({...snapshot.project!,title:'保留未保存内容',revision:snapshot.project!.revision+5});
  const saving=controller.flush(),joining=controller.flush(),disposing=controller.dispose();gate.reject(new Error('simulated save failure'));
  await Promise.all([saving,joining,disposing]);assert.equal(saveCount,1);assert.equal(controller.getSnapshot().snapshot!.project!.title,'保留未保存内容');
});

test('undo and redo use persisted history and current server revisions',async()=>{
  let snapshot=initialSnapshot();let cursor=1;const calls:Request[]=[];
  const api:StudioApi={async call<T>(endpoint:string,payload:unknown={}):Promise<T>{
    calls.push({endpoint,payload:payload as Record<string,unknown>});
    if(endpoint==='history')return {canUndo:cursor>0,canRedo:cursor<1,entries:[{id:'initial',label:'建立工程',createdAt:'2026-10-06T00:00:00Z',revision:1},{id:'edit',label:'保存修改',createdAt:'2026-10-06T00:01:00Z',revision:2}],cursor} as T;
    if(endpoint==='undo'||endpoint==='redo'){assert.equal((payload as Record<string,unknown>).expectedRevision,snapshot.project!.revision);cursor=endpoint==='undo'?0:1;snapshot={...snapshot,project:{...snapshot.project!,title:cursor?'保存修改':'建立工程',revision:snapshot.project!.revision+1}};}
    return structuredClone(snapshot) as T;
  }};
  const controller=new StudioController(api);await controller.load();assert.equal(controller.getSnapshot().canUndo,true);await controller.action('undo');assert.equal(controller.getSnapshot().canRedo,true);assert.equal(controller.getSnapshot().snapshot!.project!.title,'建立工程');await controller.action('redo');assert.equal(controller.getSnapshot().canUndo,true);
  await controller.dispose();const reopened=new StudioController(api);await reopened.load();assert.equal(reopened.getSnapshot().canUndo,true);assert.equal(reopened.getSnapshot().history!.cursor,1);assert.equal(calls.filter(call=>call.endpoint==='undo').length,1);await reopened.dispose();
});

test('remote revision conflicts preserve a local draft and block mutations until reload',async()=>{
  let snapshot=initialSnapshot();let saves=0;const controller=new StudioController(apiFor(async(endpoint)=>{if(endpoint==='save'){saves++;throw new Error('工程版本冲突');}return structuredClone(snapshot);}));
  await controller.load();const baseline=snapshot.project!.revision;controller.edit({...snapshot.project!,title:'未丢失的本地改动',revision:baseline+7});snapshot={...snapshot,project:{...snapshot.project!,title:'远端保存版本',revision:baseline+1}};await controller.load();
  assert.equal(controller.getSnapshot().conflict,true);assert.equal(controller.getSnapshot().snapshot!.project!.title,'未丢失的本地改动');await controller.flush();assert.equal(saves,0);assert.equal(controller.hasUnsavedChanges,true);await controller.load(true);assert.equal(controller.getSnapshot().conflict,false);assert.equal(controller.getSnapshot().snapshot!.project!.title,'远端保存版本');assert.equal(controller.hasUnsavedChanges,false);await controller.dispose();
});

test('an unsaved source draft blocks project navigation but can still be saved',async()=>{
  const snapshot=initialSnapshot();const requests:string[]=[];const controller=new StudioController(apiFor(async(endpoint)=>{requests.push(endpoint);return structuredClone(snapshot);}));await controller.load();controller.setSourceDraftDirty(true);assert.equal(controller.hasUnsavedChanges,true);assert.equal(controller.getSnapshot().sourceDraft,true);
  await controller.action('open',{path:'/other'});assert.equal(requests.includes('open'),false);assert.match(controller.getSnapshot().error,/源码尚未保存/);const selected=controller.getSnapshot().selected;controller.select('another-shot');assert.equal(controller.getSnapshot().selected,selected);
  await controller.saveSource(snapshot.project!.shots[0]!.id,{html:'<p>已保存</p>',css:'',js:''});assert.equal(requests.includes('saveSource'),true);controller.setSourceDraftDirty(false);assert.equal(controller.hasUnsavedChanges,false);await controller.dispose();
});
