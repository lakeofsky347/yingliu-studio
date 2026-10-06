import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioController } from '../src/client/controller.ts';
import { createProject } from '../src/core/index.ts';
import type { StudioApi, StudioSnapshot, VideoProject } from '../src/shared/types.ts';

type Request={endpoint:string;payload:Record<string,unknown>};
function initialSnapshot():StudioSnapshot{
  return {project:createProject('Controller regression'),root:'/tmp/yingliu-controller-regression',task:null,previewUrl:null,previewRevision:null,
    providers:[{id:'demo',name:'离线演示',models:[{id:'offline-director',name:'离线演示导演'}]}],
    environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false},recent:[]};
}
function apiFor(handler:(endpoint:string,payload:Record<string,unknown>)=>Promise<StudioSnapshot>|StudioSnapshot):StudioApi{
  return {async call<T>(endpoint:string,payload:unknown={}):Promise<T>{return await handler(endpoint,payload as Record<string,unknown>) as T;}};
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
