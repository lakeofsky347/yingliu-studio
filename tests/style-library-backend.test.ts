import assert from 'node:assert/strict';
import test,{after,before} from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppBackend} from '../src/app/backend.ts';
import {createApplication,MemorySecrets} from '../src/app/application.ts';
import {AppSceneGenerator} from '../src/host/generator.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import type {ProviderHost} from '../src/app/contracts.ts';
import type {StudioSnapshot,VideoStyle} from '../src/shared/types.ts';

const providers:ProviderHost={listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No paid provider is called by style tests');}};
const original={preview:VideoRenderer.prototype.preview,assetBaseUrl:VideoRenderer.prototype.assetBaseUrl,audioPreview:VideoRenderer.prototype.audioPreview,check:VideoRenderer.prototype.check};
before(()=>{
  VideoRenderer.prototype.assetBaseUrl=async()=> 'http://127.0.0.1:1/';
  VideoRenderer.prototype.preview=async()=> 'http://127.0.0.1:1/index.html';
  VideoRenderer.prototype.audioPreview=async()=>null;
  VideoRenderer.prototype.check=async()=>({ok:true,errors:[],frames:[]});
});
after(()=>Object.assign(VideoRenderer.prototype,original));
async function fixture(){
  const dataDirectory=await mkdtemp(join(tmpdir(),'yingliu-styles-')),credentials=new MemorySecrets();
  const backend=new AppBackend({dataDirectory,providers,credentials});
  return {dataDirectory,credentials,backend,async close(){await backend.dispose();await rm(dataDirectory,{recursive:true,force:true});}};
}
const styleInput={name:'暖纸拼贴',prompt:'暖纸底色与剪纸节奏',sourceFormat:'markdown' as const,sourceName:'STYLE.md'};

test('style API persists concurrent imports, edits and project copies independently of library deletion',async()=>{
  const f=await fixture();try{
    const saved=await Promise.all([styleInput,{...styleInput,name:'纪录片',prompt:'自然光与长镜头'}].map(style=>f.backend.call<{style:VideoStyle;styles:VideoStyle[]}>('styles.save',{style})));
    const styles=(await f.backend.call<{styles:VideoStyle[]}>('styles.list')).styles;assert.equal(styles.length,2);
    const selected=styles.find(style=>style.id===saved[0]!.style.id)!;
    const created=await f.backend.call<StudioSnapshot>('create',{title:'风格副本',blank:true,videoStyle:selected});
    assert.deepEqual(created.project!.videoStyle,selected);assert.equal(created.styles!.length,2);
    const changed=await f.backend.call<{style:VideoStyle}>('styles.save',{style:{...selected,name:'改名',prompt:'已修改的提示'}});
    assert.equal(changed.style.id,selected.id);assert.equal(changed.style.createdAt,selected.createdAt);
    await f.backend.call('styles.delete',{id:selected.id});
    assert.deepEqual((await f.backend.call<StudioSnapshot>('current')).project!.videoStyle,selected);
    const disk=JSON.parse(await readFile(join(f.dataDirectory,'projects','styles.json'),'utf8'));assert.equal(disk.length,1);
    await f.backend.dispose();
    const reopened=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{const current=await reopened.call<StudioSnapshot>('current');assert.deepEqual(current.project!.videoStyle,selected);assert.equal(current.styles!.length,1);}finally{await reopened.dispose();}
  }finally{await f.close();}
});

test('failed style and project index writes do not publish candidates and later writes recover',async()=>{
  const f=await fixture();try{
    const saved=await f.backend.call<{style:VideoStyle}>('styles.save',{style:styleInput});
    const created=await f.backend.call<StudioSnapshot>('create',{title:'索引事务',blank:true});
    for(const filename of ['styles.json','registry.json']){
      const path=join(f.dataDirectory,'projects',filename),committed=await readFile(path);
      await rm(path);await mkdir(path);
      try{
        const result=filename==='styles.json'?await f.backend.route('styles.save',{style:{...saved.style,prompt:'不应发布'}}):await f.backend.route('archive',{projectId:created.project!.id});
        assert.equal(result.ok,false);
        if(filename==='styles.json')assert.equal((await f.backend.call<{styles:VideoStyle[]}>('styles.list')).styles[0]!.prompt,styleInput.prompt);
        else{const list=await f.backend.call<{projects:{id:string}[];selected:string}>('list');assert.equal(list.selected,created.project!.id);assert.equal(list.projects.length,1);}
      }finally{await rm(path,{recursive:true,force:true});await writeFile(path,committed);}
    }
    await f.backend.call('styles.save',{style:{...saved.style,prompt:'后续写入成功'}});
    await f.backend.call('archive',{projectId:created.project!.id});
    assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,0);
  }finally{await f.close();}
});

test('archiving is blocked while a local project task runs',async()=>{
  const f=await fixture(),check=VideoRenderer.prototype.check;
  VideoRenderer.prototype.check=async(_root,_project,_settings,signal)=>new Promise((_,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  try{
    const created=await f.backend.call<StudioSnapshot>('create',{title:'运行中工程'});
    await f.backend.call('preview',{projectId:created.project!.id});
    const result=await f.backend.route('archive',{projectId:created.project!.id});assert.equal(result.ok,false);if(!result.ok)assert.match(result.error.message,/任务运行/);
    assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,1);
    await f.backend.call('cancel',{projectId:created.project!.id});
  }finally{VideoRenderer.prototype.check=check;await f.close();}
});

test('application exposes style endpoints and rejects invalid data without a project mutation',async()=>{
  const dataDirectory=await mkdtemp(join(tmpdir(),'yingliu-style-app-')),app=await createApplication({dataDirectory,credentials:new MemorySecrets()});
  try{
    const saved=await app.route('styles.save',{style:styleInput});assert.equal(saved.ok,true);
    const result=await app.route('styles.save',{style:{name:'坏风格',prompt:''}});assert.equal(result.ok,false);
    const listed=await app.route('styles.list');assert.equal(listed.ok,true);if(listed.ok)assert.equal((listed.value as {styles:VideoStyle[]}).styles.length,1);
    assert.equal((await app.backend.call<StudioSnapshot>('current')).project,null);
  }finally{await app.dispose();await rm(dataDirectory,{recursive:true,force:true});}
});

test('storyboard and scene generation both receive the saved video style',async()=>{
  const systems:string[]=[];
  const provider:ProviderHost={listProviders:()=>[],listModels:async()=>[{id:'fixture',name:'fixture'}],async *stream(options){
    systems.push(options.system);
    const payload=JSON.parse((options.messages[0] as {content:{text:string}[]}).content[0]!.text);
    yield {type:'text-delta',text:JSON.stringify(payload.task==='storyboard'?{shots:[{title:'风格镜头',durationSeconds:5}]}:defaultSceneSource())};yield {type:'finish',reason:{kind:'stop'}};
  }};
  const project=createProject('风格提示');project.videoStyle={id:'style',...styleInput,description:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const generator=new AppSceneGenerator({llm:provider,credentials:new MemorySecrets()}),signal=new AbortController().signal,route={provider:'fixture',model:'fixture'};
  await generator.storyboard(project,route,signal);await generator.scene(project,project.shots[0]!,route,signal);
  assert.equal(systems.length,2);for(const system of systems){assert.match(system,/暖纸拼贴/);assert.match(system,/暖纸底色与剪纸节奏/);}
});
