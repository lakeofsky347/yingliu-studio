import test, {after,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AppBackend} from '../src/app/backend.ts';
import {VideoRenderer} from '../src/host/renderer.ts';
import {createProject,defaultShot,defaultSceneSource} from '../src/core/index.ts';
import {AppSceneGenerator} from '../src/host/generator.ts';
import type {ProviderHost,SecretStore} from '../src/app/contracts.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';

// These are backend persistence/concurrency tests. Browser, mixing and media QA are stubbed.
const original={preview:VideoRenderer.prototype.preview,assetBaseUrl:VideoRenderer.prototype.assetBaseUrl,audioPreview:VideoRenderer.prototype.audioPreview,check:VideoRenderer.prototype.check};
before(()=>{
  VideoRenderer.prototype.assetBaseUrl=async()=> 'http://127.0.0.1:1/';
  VideoRenderer.prototype.preview=async(_root,project)=> 'http://127.0.0.1:1/index.html?revision='+project.revision;
  VideoRenderer.prototype.audioPreview=async()=>null;
  VideoRenderer.prototype.check=async()=>({ok:true,errors:[],frames:[]});
});
after(()=>Object.assign(VideoRenderer.prototype,original));
const providers:ProviderHost={listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('A real provider must never be called by backend tests');}};
function memoryCredentials():SecretStore{const values=new Map<string,string>();return {async get(ref){return values.get(ref);},async set(ref,value){values.set(ref,value);},async delete(ref){values.delete(ref);}};}
async function fixture(){const dataDirectory=await mkdtemp(join(tmpdir(),'yingliu-backend-'));const credentials=memoryCredentials();const backend=new AppBackend({dataDirectory,providers,credentials});return {backend,credentials,dataDirectory,async close(){await backend.dispose();await rm(dataDirectory,{recursive:true,force:true});}};}

test('blank project, same-revision concurrent commands, stable shot IDs and CAS errors',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'空白分镜',topic:'人工与模型共用工程',blank:true});
    assert.equal(first.project!.shots.length,0);assert.deepEqual(first.project!.shotOrder,[]);assert.ok(first.root!.startsWith(join(f.dataDirectory,'projects')));
    assert.deepEqual(first.project!.graph.positions['film-output'],[375,140]);
    const shot=defaultShot();const added=await f.backend.call<StudioSnapshot>('apply',{projectId:first.project!.id,expectedRevision:0,shots:[shot],shotOrder:[shot.id],extensions:{graphEdges:[{from:shot.id,to:'film-output'}]}});
    assert.equal(added.project!.revision,1);assert.equal(added.project!.shots[0]!.id,shot.id);
    const results=await Promise.all(['第一次提交','过期并发提交'].map(text=>f.backend.route('apply',{projectId:first.project!.id,expectedRevision:1,shotPatches:[{id:shot.id,patch:{params:{...shot.params,text}}}]})));
    assert.equal(results.filter(r=>r.ok).length,1);const conflict=results.find(r=>!r.ok);assert.ok(conflict&&!conflict.ok);assert.equal(conflict.error.code,'REVISION_CONFLICT');
    const current=await f.backend.call<StudioSnapshot>('current',{projectId:first.project!.id});assert.equal(current.project!.revision,2);assert.equal(current.project!.shots[0]!.params.text,'第一次提交');
    const noRevision=await f.backend.route('apply',{projectId:first.project!.id,title:'不应写入'});assert.ok(!noRevision.ok);assert.equal(noRevision.error.code,'REVISION_REQUIRED');
    const disk=JSON.parse(await readFile(join(first.root!,'project.json'),'utf8'));assert.equal(disk.revision,2);assert.equal(disk.title,'空白分镜');
  }finally{await f.close();}
});

test('save and source endpoints reject stale versions at their serialized commit point',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'保存冲突'});const id=first.project!.id,shotId=first.project!.shots[0]!.id;
    const updated=await f.backend.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:0,title:'最新标题'});
    const stale=await f.backend.route('save',{projectId:id,expectedRevision:0,project:{...first.project!,title:'旧标题',revision:999}});assert.ok(!stale.ok);assert.equal(stale.error.code,'REVISION_CONFLICT');
    const source=await f.backend.call('source',{projectId:id,shotId});
    for(const endpoint of ['saveSource','restoreSource']){const result=await f.backend.route(endpoint,{projectId:id,shotId,expectedRevision:0,source:defaultSceneSource()});assert.ok(!result.ok);assert.equal(result.error.code,'REVISION_CONFLICT');}
    assert.deepEqual(await f.backend.call('source',{projectId:id,shotId}),source);
    const saved=await f.backend.call<StudioSnapshot>('save',{projectId:id,expectedRevision:updated.project!.revision,project:{...updated.project!,title:'继续编辑',revision:999}});
    assert.equal(saved.project!.revision,2);assert.equal(saved.project!.title,'继续编辑');
  }finally{await f.close();}
});

test('projects remain isolated and indexed project reopening preserves revisions',async()=>{
  const f=await fixture();try{
    const a=await f.backend.call<StudioSnapshot>('create',{title:'工程 A'}),b=await f.backend.call<StudioSnapshot>('create',{title:'工程 B'});
    await Promise.all([f.backend.call('apply',{projectId:a.project!.id,expectedRevision:0,title:'A 已修改'}),f.backend.call('apply',{projectId:b.project!.id,expectedRevision:0,title:'B 已修改'})]);
    const list=await f.backend.call<{projects:{id:string;path:string}[]}>('list');assert.equal(list.projects.length,2);
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{
      const restoredA=await restarted.call<StudioSnapshot>('current',{projectId:a.project!.id}),restoredB=await restarted.call<StudioSnapshot>('current',{projectId:b.project!.id});
      assert.equal(restoredA.project!.title,'A 已修改');assert.equal(restoredA.project!.revision,1);assert.equal(restoredB.project!.title,'B 已修改');assert.equal(restoredB.project!.revision,1);
    }finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('unfinished task journal is recovered as an explicit interrupted failure',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'任务恢复'});const folder=join(first.root!,'.studio','tasks');await mkdir(folder,{recursive:true});
    const record={id:'interrupted-export',kind:'export',status:'running',progress:.4,message:'捕帧中',startedAt:'2026-10-06T00:00:00.000Z'};await writeFile(join(folder,record.id+'.json'),JSON.stringify(record));
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{
      const current=await restarted.call<StudioSnapshot>('current',{projectId:first.project!.id});assert.equal(current.task!.status,'failed');assert.match(current.task!.error!,/TASK_INTERRUPTED/);assert.match(current.task!.message,/中断/);
      const disk=JSON.parse(await readFile(join(folder,record.id+'.json'),'utf8'));assert.equal(disk.status,'failed');assert.ok(disk.finishedAt);
    }finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('task starts with durable journal and cancellation retains an owned task record',async()=>{
  const f=await fixture(),previousCheck=VideoRenderer.prototype.check;
  VideoRenderer.prototype.check=async(_root,_project,_settings,signal)=>new Promise((_,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'任务取消'}),running=await f.backend.call<StudioSnapshot>('preview',{projectId:first.project!.id});
    assert.equal(running.task!.status,'running');const path=running.task!.logPath!;assert.equal(JSON.parse(await readFile(path,'utf8')).status,'running');
    await f.backend.call('cancel',{projectId:first.project!.id});
    for(let i=0;i<20;i++){const current=await f.backend.call<StudioSnapshot>('current',{projectId:first.project!.id});if(current.task!.status==='cancelled')break;await new Promise(resolve=>setTimeout(resolve,5));}
    await f.backend.dispose();const record=JSON.parse(await readFile(path,'utf8'));assert.equal(record.status,'cancelled');assert.ok(record.finishedAt);
  }finally{VideoRenderer.prototype.check=previousCheck;await f.close();}
});

test('TTS credentials are kept in SecretStore and native reveal receives only project-local paths',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'凭据边界'});const snapshot=await f.backend.call<StudioSnapshot>('tts',{apiKey:'synthetic-test-key',enabled:true,endpoint:'https://example.invalid',model:'fake',voice:'fake'});
    assert.equal(await f.credentials.get('YINGLIU_TTS_API_KEY'),'synthetic-test-key');assert.equal(snapshot.ttsConfigured,true);assert.equal(snapshot.tts!.apiKey,undefined);
    assert.ok(!(await readFile(join(f.dataDirectory,'projects','tts.json'),'utf8')).includes('synthetic-test-key'));assert.ok(!(await readFile(join(first.root!,'project.json'),'utf8')).includes('synthetic-test-key'));
    const outside=await f.backend.route('reveal',{path:join(f.dataDirectory,'outside')});assert.ok(!outside.ok);assert.match(outside.error.message,/本项目/);
    await f.backend.call('tts',{apiKey:''});assert.equal(await f.credentials.get('YINGLIU_TTS_API_KEY'),undefined);
  }finally{await f.close();}
});

test('scene generator sends text metadata and an explicit no-image-pixels boundary',async()=>{
  let request:Parameters<ProviderHost['stream']>[0]|undefined;
  const textProvider:ProviderHost={
    listProviders:()=>[{id:'fixture',name:'test-only'}],listModels:async()=>[{id:'text-fixture',name:'text-fixture',inputModalities:['text','image']}],
    async *stream(options){request=options;yield {type:'text-delta',text:JSON.stringify({shots:[{title:'文字说明分镜',durationSeconds:5,assetIds:['local-image']}]})};yield {type:'finish',reason:{kind:'stop'}};},
  };
  const project=createProject('图片保留本机');project.assets.push({id:'local-image',kind:'image',name:'用户图片',description:'用户明确说明的蓝色山峰',path:'assets/not-read.png',mime:'image/png'});
  const generator=new AppSceneGenerator({llm:textProvider,credentials:memoryCredentials()});
  const shots=await generator.storyboard(project,{provider:'fixture',model:'text-fixture'},new AbortController().signal);
  assert.equal(shots.length,1);assert.deepEqual(shots[0]!.assetIds,['local-image']);
  const content=(request!.messages[0] as {content:{type:string;text:string}[]}).content;
  assert.equal(content.length,1);assert.equal(content[0]!.type,'text');assert.match(content[0]!.text,/图片像素没有发送/);assert.match(content[0]!.text,/用户明确说明的蓝色山峰/);
  assert.ok(!content[0]!.text.includes('data:image'));
});
