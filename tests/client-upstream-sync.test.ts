import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/core/index.ts';
import { StudioController } from '../src/client/controller.ts';
import { SourceDraftStore } from '../src/client/source-drafts.ts';
import { briefPayload } from '../src/client/project-ui.ts';
import type { SceneSource, StudioApi, StudioSnapshot, VideoStyle } from '../src/shared/types.ts';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>{resolve=accept;});return {promise,resolve};}
function fixture(){
  let snapshot:StudioSnapshot={project:createProject('同步回归'),root:'/fixture',task:null,previewUrl:null,previewRevision:null,providers:[],recent:[],environment:{browserPath:'',ffmpegPath:'',ffprobePath:'',browserAvailable:false,ffmpegAvailable:false,ffprobeAvailable:false}};
  const calls:{endpoint:string;payload:Record<string,any>}[]=[];
  const api:StudioApi={async call<T>(endpoint:string,payload:Record<string,any>={}){
    calls.push({endpoint,payload:structuredClone(payload)});
    if(endpoint==='history')return {canUndo:false,canRedo:false,entries:[],cursor:0} as T;
    if(endpoint==='saveSource'){snapshot={...snapshot,project:{...snapshot.project!,revision:snapshot.project!.revision+1}};}
    if(endpoint==='focus'&&payload.projectId!==snapshot.project?.id)snapshot={...snapshot,project:{...createProject('另一影片'),id:payload.projectId}};
    return structuredClone(snapshot) as T;
  }};
  return {api,calls,get snapshot(){return snapshot;},set snapshot(value:StudioSnapshot){snapshot=value;}};
}
const source:SceneSource={html:'<h1>草稿</h1>',css:'h1{color:red}',js:'export function render(){}'};
function draftStorage(){const data=new Map<string,string>();return {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};}

test('persisted source drafts retain their original revision across shot changes, project navigation and reload',async()=>{
  const f=fixture(),storage=draftStorage(),controller=new StudioController(f.api,new SourceDraftStore(storage));await controller.load();
  const projectId=f.snapshot.project!.id,[first,second]=f.snapshot.project!.shots;
  controller.select(first!.id);controller.setSourceDraft(first!.id,source,controller.confirmedRevision!);
  controller.select(second!.id);assert.equal(controller.getSnapshot().selected,second!.id);
  controller.setSourceDraft(first!.id,{...source,css:'h1{color:blue}'},999);
  assert.equal(controller.getSourceDraft(first!.id)!.baseRevision,0);
  await controller.focusProject('project-b');assert.equal(controller.getSnapshot().sourceDraft,false);
  assert.equal(controller.getSourceDraft(first!.id,projectId)!.source.css,'h1{color:blue}');
  assert.equal(new SourceDraftStore(storage).get(projectId,first!.id)!.baseRevision,0);
  await controller.dispose();
});

test('a failed source save preserves the draft and an explicit retry carries its original CAS revision',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api);let rejected=true;
  f.api.call=async<T>(endpoint:string,payload:unknown={})=>{if(endpoint==='saveSource'&&rejected)throw new Error('工程版本冲突');return base<T>(endpoint,payload);};
  const controller=new StudioController(f.api,new SourceDraftStore(draftStorage()));await controller.load();
  const shot=f.snapshot.project!.shots[0]!;controller.setSourceDraft(shot.id,source,0);
  assert.equal(await controller.saveSource(shot.id,source),false);assert.deepEqual(controller.getSourceDraft(shot.id)!.source,source);
  f.snapshot={...f.snapshot,project:{...f.snapshot.project!,revision:2}};await controller.load();
  assert.equal(controller.getSourceDraft(shot.id)!.baseRevision,0);
  rejected=false;assert.equal(await controller.saveSource(shot.id,source,true),true);
  assert.equal(f.calls.find(call=>call.endpoint==='saveSource')!.payload.expectedRevision,2);
  assert.equal(controller.getSourceDraft(shot.id),undefined);assert.equal(controller.hasUnsavedChanges,false);await controller.dispose();
});

test('a delayed current-project read cannot overwrite a later local edit',async()=>{
  const f=fixture(),base=f.api.call.bind(f.api),old=deferred<StudioSnapshot>();
  f.api.call=async<T>(endpoint:string,payload:unknown={})=>endpoint==='current'?old.promise as Promise<T>:base<T>(endpoint,payload);
  const controller=new StudioController(f.api);await controller.load();const reading=controller.refreshMediaProject();
  controller.edit({...f.snapshot.project!,title:'保留后写的标题'});old.resolve({...f.snapshot,project:{...f.snapshot.project!,title:'过时响应'}});
  assert.equal(await reading,false);assert.equal(controller.getSnapshot().snapshot?.project?.title,'保留后写的标题');
  await controller.dispose();
});

test('creation keeps an independent copy of the selected custom video style',()=>{
  const style:VideoStyle={id:'custom-style',name:'手绘',description:'铅笔线条',prompt:'用铅笔线条和暖纸背景',sourceFormat:'custom',sourceName:'手绘',createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z'};
  const payload=briefPayload({title:'风格影片',topic:'主题',duration:6,profile:'presentation-landscape',preset:'clear-message',mode:'blank',videoStyle:style});
  style.prompt='之后编辑风格库';assert.equal(payload.videoStyle!.prompt,'用铅笔线条和暖纸背景');
});
