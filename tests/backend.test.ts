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


async function finished(backend:AppBackend,projectId:string):Promise<StudioSnapshot>{
  for(let i=0;i<100;i++){
    const current=await backend.call<StudioSnapshot>('current',{projectId});
    if(current.task?.status!=='running'){
      if(!current.task?.logPath||JSON.parse(await readFile(current.task.logPath,'utf8')).status===current.task.status)return current;
    }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Local fixture task did not finish');
}

test('backend full apply is one durable undo step across restart and source restoration',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'持久撤销'}),id=first.project!.id,shotId=first.project!.shots[0]!.id;
    const changed={...defaultSceneSource(),html:'<article>模型完整修改</article>'};
    const applied=await f.backend.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:0,title:'一次变更后的标题',shotPatches:[{id:shotId,patch:{narration:'修改后的旁白'}}],sources:[{shotId,source:changed}]});assert.equal(applied.project!.revision,1);
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{
      const history=await restarted.call<{canUndo:boolean;canRedo:boolean;cursor:number;entries:unknown[]}>('history',{projectId:id});assert.equal(history.entries.length,2);assert.equal(history.cursor,1);
      const undone=await restarted.call<StudioSnapshot>('undo',{projectId:id,expectedRevision:1});assert.equal(undone.project!.revision,2);assert.equal(undone.project!.title,'持久撤销');assert.deepEqual(await restarted.call('source',{projectId:id,shotId}),defaultSceneSource());
      const stale=await restarted.route('redo',{projectId:id,expectedRevision:1});assert.ok(!stale.ok);assert.equal(stale.error.code,'REVISION_CONFLICT');
      const redone=await restarted.call<StudioSnapshot>('redo',{projectId:id,expectedRevision:2});assert.equal(redone.project!.revision,3);assert.equal(redone.project!.title,'一次变更后的标题');assert.deepEqual(await restarted.call('source',{projectId:id,shotId}),changed);
    }finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('rename, duplicate and archive preserve isolated files and hidden index across restart',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'工程管理'}),id=first.project!.id,shotId=first.project!.shots[0]!.id;
    await f.backend.call('apply',{projectId:id,expectedRevision:0,sources:[{shotId,source:{...defaultSceneSource(),html:'<p>独立副本源码</p>'}}]});
    const renamed=await f.backend.call<StudioSnapshot>('rename',{projectId:id,expectedRevision:1,title:'重命名工程'});assert.equal(renamed.project!.revision,2);
    const duplicate=await f.backend.call<StudioSnapshot>('duplicate',{projectId:id,title:'我的副本'});assert.notEqual(duplicate.project!.id,id);assert.equal(duplicate.project!.revision,0);assert.equal(duplicate.project!.title,'我的副本');assert.equal(duplicate.project!.outputs.length,0);
    assert.deepEqual(await f.backend.call('source',{projectId:duplicate.project!.id,shotId}),await f.backend.call('source',{projectId:id,shotId}));
    await f.backend.call('archive',{projectId:id});assert.equal((await f.backend.call<{projects:any[]}>('list')).projects.length,1);
    const all=await f.backend.call<{projects:any[]}>('list',{includeArchived:true});assert.equal(all.projects.length,2);assert.equal(all.projects.find(item=>item.id===id).archived,true);assert.ok(all.projects.find(item=>item.id===id).archivedAt);assert.equal(JSON.parse(await readFile(join(first.root!,'project.json'),'utf8')).title,'重命名工程');
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{
      assert.equal((await restarted.call<{projects:any[]}>('list')).projects.length,1);const archived=await restarted.route('current',{projectId:id});assert.ok(!archived.ok);assert.match(archived.error.message,/归档/);
      const restored=await restarted.call<StudioSnapshot>('restore',{projectId:id});assert.equal(restored.project!.title,'重命名工程');assert.equal(restored.project!.revision,2);assert.equal((await restarted.call<{projects:any[]}>('list')).projects.length,2);
      await restarted.call('apply',{projectId:duplicate.project!.id,expectedRevision:0,title:'副本单独修改'});assert.equal((await restarted.call<StudioSnapshot>('current',{projectId:id})).project!.title,'重命名工程');
    }finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('archiving the only project keeps no hidden project selected after restart',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'唯一工程'});const archived=await f.backend.call<StudioSnapshot>('archive',{projectId:first.project!.id});assert.equal(archived.project,null);
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{assert.equal((await restarted.call<StudioSnapshot>('current')).project,null);assert.equal((await restarted.call<{projects:any[]}>('list')).projects.length,0);assert.equal((await restarted.call<{projects:any[]}>('list',{includeArchived:true})).projects.length,1);}finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('failed owned task history is durable, redacted and retryable with current CAS',async()=>{
  const f=await fixture(),previousCheck=VideoRenderer.prototype.check;let calls=0;
  VideoRenderer.prototype.check=async()=>{calls++;if(calls===1)throw new Error('provider error fixture-model-secret; Authorization Bearer fixture-bearer-secret');return {ok:true,errors:[],frames:[]};};
  try{
    await f.credentials.set('yingliu.custom-model.api-key','fixture-model-secret');
    const first=await f.backend.call<StudioSnapshot>('create',{title:'任务重试'}),id=first.project!.id;
    await f.backend.call('preview',{projectId:id,expectedRevision:0,apiKey:'not-to-be-logged',endpoint:'environment'});const failed=await finished(f.backend,id);assert.equal(failed.task!.status,'failed');
    const log=await readFile(failed.task!.logPath!,'utf8');assert.ok(!log.includes('fixture-model-secret'));assert.ok(!log.includes('fixture-bearer-secret'));assert.ok(!log.includes('not-to-be-logged'));
    const tasks=await f.backend.call<{tasks:any[]}>('tasks',{projectId:id});assert.equal(tasks.tasks.length,1);assert.equal(tasks.tasks[0].retryable,true);assert.deepEqual(tasks.tasks[0].request,{endpoint:'preview',payload:{}});
    const updated=await f.backend.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:0,title:'重试基于当前版本'});
    const stale=await f.backend.route('retry',{projectId:id,taskId:failed.task!.id,expectedRevision:0});assert.ok(!stale.ok);assert.equal(stale.error.code,'REVISION_CONFLICT');
    const retried=await f.backend.call<StudioSnapshot>('retry',{projectId:id,taskId:failed.task!.id,expectedRevision:updated.project!.revision});assert.notEqual(retried.task!.id,failed.task!.id);
    await finished(f.backend,id);const jobs=await f.backend.call<{tasks:any[]}>('jobs',{projectId:id});const retry=jobs.tasks.find(task=>task.retryOf===failed.task!.id);assert.equal(retry.status,'complete');assert.equal(retry.revision,1);assert.equal(jobs.tasks.length,2);
    const invalid={id:'not-owned-request',kind:'export',status:'failed',progress:0,message:'fixture',startedAt:'2026-10-06T00:00:00Z',appRecordVersion:1,request:{endpoint:'environment',payload:{browserPath:'/arbitrary'}}};await writeFile(join(first.root!,'.studio','tasks',invalid.id+'.json'),JSON.stringify(invalid));
    const rejected=await f.backend.route('retry',{projectId:id,taskId:invalid.id,expectedRevision:1});assert.ok(!rejected.ok);assert.match(rejected.error.message,/没有可重试/);
    await f.backend.dispose();const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});try{assert.equal((await restarted.call<{tasks:any[]}>('tasks',{projectId:id})).tasks.length,3);}finally{await restarted.dispose();}
  }finally{VideoRenderer.prototype.check=previousCheck;await f.close();}
});

test('first creation accepts complete project and sources atomically without partial indexed project',async()=>{
  const f=await fixture();try{
    const project=createProject('模型首次创建');const sources=project.shots.map((shot,i)=>({shotId:shot.id,source:{...defaultSceneSource(),html:'<p>候选镜头 '+i+'</p>'}}));
    const invalid=await f.backend.route('create',{project,sources:[...sources,{shotId:'unknown',source:defaultSceneSource()}]});assert.ok(!invalid.ok);assert.equal((await f.backend.call<{projects:any[]}>('list')).projects.length,0);
    const created=await f.backend.call<StudioSnapshot>('create',{project,sources});assert.equal(created.project!.id,project.id);assert.equal(created.project!.revision,0);assert.deepEqual(created.project!.shotOrder,project.shotOrder);assert.deepEqual(await f.backend.call('source',{projectId:project.id,shotId:project.shots[2]!.id}),sources[2]!.source);
    const collision=await f.backend.route('create',{project,sources});assert.ok(!collision.ok);assert.equal((await f.backend.call<{projects:any[]}>('list')).projects.length,1);
    const manual=await f.backend.call<StudioSnapshot>('create',{title:'向导',topic:'创建属性',blank:true,profile:'canvas-2d',preset:'watercolor',targetDuration:12,target:{width:1280,height:720}});assert.deepEqual(manual.project!.extensions.brief,{profile:'canvas-2d',preset:'watercolor'});assert.equal(manual.project!.targetDuration,12);assert.equal(manual.project!.target.width,1280);
  }finally{await f.close();}
});

test('a preview validation failure preserves committed source and allows full undo',async()=>{
  const f=await fixture(),previousCheck=VideoRenderer.prototype.check;VideoRenderer.prototype.check=async()=>({ok:false,errors:[{message:'fixture renderer failure'}],frames:[]});
  try{
    const created=await f.backend.call<StudioSnapshot>('create',{title:'保留失败源码'}),id=created.project!.id,shotId=created.project!.shots[0]!.id,source={...defaultSceneSource(),js:'export function render(ctx){throw new Error("bad-code-fixture")}'};
    await f.backend.call('saveSource',{projectId:id,shotId,expectedRevision:0,source});const failed=await finished(f.backend,id);assert.equal(failed.task!.status,'failed');assert.equal(failed.project!.revision,1);assert.deepEqual(await f.backend.call('source',{projectId:id,shotId}),source);
    const undone=await f.backend.call<StudioSnapshot>('undo',{projectId:id,expectedRevision:1});assert.equal(undone.project!.revision,2);assert.deepEqual(await f.backend.call('source',{projectId:id,shotId}),defaultSceneSource());
  }finally{VideoRenderer.prototype.check=previousCheck;await f.close();}
});

test('missing selected directory on restart leaves the project picker usable',async()=>{
  const f=await fixture();try{
    const created=await f.backend.call<StudioSnapshot>('create',{title:'工程目录已移动'});await f.backend.dispose();await rm(created.root!,{recursive:true,force:true});
    const restarted=new AppBackend({dataDirectory:f.dataDirectory,providers,credentials:f.credentials});
    try{assert.equal((await restarted.call<StudioSnapshot>('current')).project,null);assert.equal((await restarted.call<{projects:unknown[]}>('list')).projects.length,1);const fresh=await restarted.call<StudioSnapshot>('create',{title:'仍能创建工程',blank:true});assert.equal(fresh.project!.title,'仍能创建工程');}finally{await restarted.dispose();}
  }finally{await f.close();}
});

test('recorded generation task commits multiple scenes as one undoable change and retries locally',async()=>{
  const dataDirectory=await mkdtemp(join(tmpdir(),'yingliu-generate-history-'));let calls=0;
  const localProvider:ProviderHost={listProviders:()=>[{id:'fixture',name:'offline test fixture'}],listModels:async()=>[{id:'fixture-source',name:'fixture-source'}],async *stream(){calls++;yield {type:'text-delta',text:JSON.stringify({...defaultSceneSource(),html:'<p>fixture generation '+calls+'</p>',shotPatch:{narration:'fixture旁白'}})};yield {type:'finish',reason:{kind:'stop'}};}};
  const backend=new AppBackend({dataDirectory,providers:localProvider,credentials:memoryCredentials()});
  try{
    const created=await backend.call<StudioSnapshot>('create',{title:'多镜生成历史'}),id=created.project!.id;
    await backend.call('generate',{projectId:id,expectedRevision:0,kind:'scenes',provider:'fixture',model:'fixture-source'});const generated=await finished(backend,id);assert.equal(generated.task!.status,'complete');assert.equal(generated.project!.revision,3);assert.equal(calls,3);
    const history=await backend.call<{entries:unknown[]}>('history',{projectId:id});assert.equal(history.entries.length,2);
    const undone=await backend.call<StudioSnapshot>('undo',{projectId:id,expectedRevision:3});assert.equal(undone.project!.revision,4);for(const shot of undone.project!.shots)assert.deepEqual(await backend.call('source',{projectId:id,shotId:shot.id}),defaultSceneSource());
    await backend.call('retry',{projectId:id,taskId:generated.task!.id,expectedRevision:4});const retried=await finished(backend,id);assert.equal(retried.task!.status,'complete');assert.equal(retried.project!.revision,7);assert.equal(calls,6);
    const tasks=await backend.call<{tasks:any[]}>('tasks',{projectId:id});assert.equal(tasks.tasks.length,2);assert.ok(tasks.tasks.some(task=>task.retryOf===generated.task!.id));assert.equal((await backend.call<{entries:unknown[]}>('history',{projectId:id})).entries.length,2);
  }finally{await backend.dispose();await rm(dataDirectory,{recursive:true,force:true});}
});

test('preview preparation failure reports durable committed project without losing the index',async()=>{
  const f=await fixture(),previousPreview=VideoRenderer.prototype.preview;
  try{
    const created=await f.backend.call<StudioSnapshot>('create',{title:'预览失败后的提交'}),id=created.project!.id;
    VideoRenderer.prototype.preview=async()=>{throw new Error('fixture: preview unavailable');};
    const applied=await f.backend.call<StudioSnapshot>('apply',{projectId:id,expectedRevision:0,title:'已保存且可以撤销'});assert.equal(applied.project!.revision,1);assert.equal(applied.task!.status,'failed');assert.match(applied.task!.message,/已保存/);assert.equal(applied.previewUrl,null);
    assert.equal((await f.backend.call<{projects:any[]}>('list')).projects[0].title,'已保存且可以撤销');assert.equal(JSON.parse(await readFile(applied.task!.logPath!,'utf8')).status,'failed');
    VideoRenderer.prototype.preview=previousPreview;const undone=await f.backend.call<StudioSnapshot>('undo',{projectId:id,expectedRevision:1});assert.equal(undone.project!.title,'预览失败后的提交');assert.equal(undone.project!.revision,2);
  }finally{VideoRenderer.prototype.preview=previousPreview;await f.close();}
});

test('failed export retries only its recorded request and records current input revision',async()=>{
  const f=await fixture(),previousExport=VideoRenderer.prototype.export;let calls=0;
  VideoRenderer.prototype.export=async(root,project)=>{calls++;if(calls===1)throw new Error('fixture: export worker failed');return {id:'fixture-export-'+calls,path:join(root,'exports','fixture-export-'+calls,'video.mp4'),revision:project.revision,createdAt:new Date().toISOString(),duration:30} as any;};
  try{
    const created=await f.backend.call<StudioSnapshot>('create',{title:'导出重试'}),id=created.project!.id;
    await f.backend.call('export',{projectId:id,expectedRevision:0,apiKey:'must-not-be-journaled'});const failed=await finished(f.backend,id);assert.equal(failed.task!.status,'failed');assert.equal(failed.project!.outputs.length,0);
    await f.backend.call('apply',{projectId:id,expectedRevision:0,title:'重试时的工程'});
    await f.backend.call('retry',{projectId:id,taskId:failed.task!.id,expectedRevision:1});const retried=await finished(f.backend,id);assert.equal(retried.task!.status,'complete');assert.equal(retried.project!.revision,2);assert.equal(retried.project!.outputs.length,1);assert.equal(retried.project!.outputs[0]!.revision,1);assert.ok(retried.project!.outputs[0]!.url);
    const tasks=await f.backend.call<{tasks:any[]}>('tasks',{projectId:id});assert.ok(tasks.tasks.every(task=>task.request.endpoint==='export'&&Object.keys(task.request.payload).length===0));assert.ok(tasks.tasks.some(task=>task.retryOf===failed.task!.id));assert.ok(!(await readFile(failed.task!.logPath!,'utf8')).includes('must-not-be-journaled'));
  }finally{VideoRenderer.prototype.export=previousExport;await f.close();}
});
