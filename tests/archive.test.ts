import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,open,stat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync,unzipSync} from 'fflate';
import {AppBackend} from '../src/app/backend.ts';
import {MemorySecrets,createApplication} from '../src/app/application.ts';
import {exportProjectArchive,importProjectArchive} from '../src/app/archive.ts';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import {createFileSymlinkOrSkip} from './fixtures/symlink.ts';

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'yingliu-archive-'));
  const backend=new AppBackend({dataDirectory:directory,credentials:new MemorySecrets(),providers:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('No provider in archive tests');}}});
  return {directory,backend,async close(){await backend.dispose();await rm(directory,{recursive:true,force:true});}};
}
test('editable backup roundtrip preserves custom source and bytes, creates isolated project without outputs or credentials',async()=>{
  const f=await fixture();try{
    const project=createProject('可编辑备份','自己的主题');const source={...defaultSceneSource(),css:'body { background: #123456; }'};
    project.assets=[{id:'image-a',name:'用户素材',description:'本地合成测试文件',kind:'image',mime:'image/png',path:'assets/image-a.png'}];
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    const original=await f.backend.call<StudioSnapshot>('create',{project,sources:project.shots.map(shot=>({shotId:shot.id,source})),assetFiles:[{path:'assets/image-a.png',dataBase64:bytes.toString('base64')}]});
    await writeFile(join(f.directory,'provider.json'),'secret must not enter backup');
    const exported=await exportProjectArchive(f.backend,{projectId:project.id});assert.ok(exported.dataBase64);assert.equal(exported.name,'可编辑备份.yingliu');
    const files=unzipSync(Buffer.from(exported.dataBase64!,'base64'));assert.equal(Object.keys(files).length,6);assert.ok(!Object.keys(files).some(name=>/provider|credentials|conversation|tasks/.test(name)));
    const restored=await importProjectArchive(f.backend,{dataBase64:exported.dataBase64});assert.notEqual(restored.project!.id,project.id);assert.notEqual(restored.root,original.root);
    assert.equal(restored.project!.revision,0);assert.equal(restored.project!.topic,project.topic);assert.deepEqual(restored.project!.outputs,[]);
    assert.deepEqual(await f.backend.call('source',{projectId:restored.project!.id,shotId:project.shots[0]!.id}),source);
    assert.deepEqual(await readFile(join(restored.root!,'assets/image-a.png')),bytes);
    const saved=await exportProjectArchive(f.backend,{projectId:restored.project!.id,path:join(f.directory,'backup.yingliu')});assert.equal(saved.dataBase64,undefined);assert.equal((await readFile(saved.path!)).length,saved.size);
  }finally{await f.close();}
});
test('corrupt hashes, traversal paths, missing sources and unknown ZIP files never register a partial project',async()=>{
  const f=await fixture();try{
    const first=await f.backend.call<StudioSnapshot>('create',{title:'完整工程'});const exported=await exportProjectArchive(f.backend,{projectId:first.project!.id});
    const pristine=Buffer.from(exported.dataBase64!,'base64');const files=unzipSync(pristine);
    const corrupted={...files,'project.json':Buffer.from('{}')};
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:Buffer.from(zipSync(corrupted)).toString('base64')}),/损坏/);
    for(const path of ['assets/../outside','assets//double','credentials.json']){
      const unsafe={...files,[path]:Buffer.from('unsafe')};await assert.rejects(importProjectArchive(f.backend,{dataBase64:Buffer.from(zipSync(unsafe)).toString('base64')}),/不支持|不安全/);
    }
    const missing={...files};delete missing['sources/'+first.project!.shots[0]!.id+'.json'];await assert.rejects(importProjectArchive(f.backend,{dataBase64:Buffer.from(zipSync(missing)).toString('base64')}),/清单/);
    assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,1);
  }finally{await f.close();}
});
test('ZIP expansion is bounded before importing',async()=>{
  const f=await fixture();try{
    const bomb=zipSync({'project.json':new Uint8Array(24*1024*1024+1)});assert.ok(bomb.length<100000);
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:Buffer.from(bomb).toString('base64')}),/24 MiB|安全大小/);
  }finally{await f.close();}
});
test('project-local file symlinks are refused before exporting',async context=>{
  const f=await fixture();try{
    const snapshot=await f.backend.call<StudioSnapshot>('create',{title:'符号链接边界'});const outside=join(f.directory,'outside.bin');await writeFile(outside,'must stay outside');
    const imported=await f.backend.call<StudioSnapshot>('import',{projectId:snapshot.project!.id,expectedRevision:snapshot.project!.revision,name:'fixture.png',mime:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});const asset=imported.project!.assets[0]!;
    await rm(join(snapshot.root!,asset.path!));if(!await createFileSymlinkOrSkip(context,outside,join(snapshot.root!,asset.path!)))return;
    await assert.rejects(exportProjectArchive(f.backend,{projectId:snapshot.project!.id}),/符号|symlink|越界|本项目|路径/i);
  }finally{await f.close();}
});
test('application shutdown is idempotent and refuses new writes after draining',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-lifecycle-'));const app=await createApplication({dataDirectory:directory,credentials:new MemorySecrets()});
  try{const result=await app.route('create',{blank:true,title:'关闭生命周期',operationId:'create-lifecycle',expectedRevision:null});assert.equal(result.ok,true);await Promise.all([app.dispose(),app.dispose()]);const late=await app.route('create',{blank:true});assert.ok(!late.ok);assert.equal(late.error.code,'APP_SHUTTING_DOWN');}
  finally{await app.dispose();await rm(directory,{recursive:true,force:true});}
});

async function fileHash(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

test('v2 path archives stream video-sized assets above legacy and browser limits without base64',async()=>{
  const f=await fixture();try{
    const project=createProject('大素材备份'),source=join(f.directory,'media-byte-fixture.mp4'),originalFile=join(f.directory,'original.webm'),originalBytes=Buffer.from('original container bytes; archive fixture only'),size=65*1024*1024+37;
    await writeFile(originalFile,originalBytes);
    const handle=await open(source,'w');try{await handle.truncate(size);await handle.write(Buffer.from('archive bytes only; not a real codec fixture'),0,42,0);}finally{await handle.close();}
    project.assets=[{id:'video-byte-fixture',kind:'video',name:'备份字节验收',description:'仅验证大文件流式备份，不作为视频解码验收',path:'assets/video-byte-fixture.mp4',originalPath:'assets/video-byte-fixture.original.webm',mime:'video/mp4',width:64,height:64,duration:4,fps:{num:30,den:1},frameCount:120,hasAudio:false}];
    project.videoClips=[{id:'video-clip',assetId:project.assets[0]!.id,shotId:project.shots[0]!.id,trimStart:1,trimEnd:3,speed:1,fit:'contain',audio:'mute'}];
    const original=await f.backend.call<StudioSnapshot>('create',{project,assetFiles:[{path:project.assets[0]!.path,localPath:source},{path:project.assets[0]!.originalPath,localPath:originalFile}]});
    await assert.rejects(exportProjectArchive(f.backend,{projectId:original.project!.id}),/64 MiB.*桌面/);
    const archivePath=join(f.directory,'large.yingliu'),saved=await exportProjectArchive(f.backend,{projectId:original.project!.id,path:archivePath});
    assert.equal(saved.dataBase64,undefined);assert.ok(saved.size>size);assert.equal((await stat(archivePath)).size,saved.size);
    const restored=await importProjectArchive(f.backend,{path:archivePath});assert.equal(restored.project!.schemaVersion,2);assert.notEqual(restored.project!.id,original.project!.id);
    assert.deepEqual(restored.project!.videoClips,project.videoClips);assert.equal(restored.project!.shots[0]!.id,project.shots[0]!.id);
    assert.equal(await fileHash(join(restored.root!,project.assets[0]!.path!)),await fileHash(source));
    assert.equal(restored.project!.assets[0]!.originalPath,project.assets[0]!.originalPath);assert.deepEqual(await readFile(join(restored.root!,project.assets[0]!.originalPath!)),originalBytes);
    assert.equal((await readdir(f.directory)).some(name=>name.includes('.tmp-')),false);
  }finally{await f.close();}
});

test('v1 archives still migrate and preserve stable content IDs; truncated ZIP directories are rejected',async()=>{
  const f=await fixture();try{
    const original=await f.backend.call<StudioSnapshot>('create',{title:'旧格式兼容'}),exported=await exportProjectArchive(f.backend,{projectId:original.project!.id}),bytes=Buffer.from(exported.dataBase64!,'base64');
    const files=unzipSync(bytes),project=JSON.parse(Buffer.from(files['project.json']!).toString('utf8'));project.schemaVersion=1;delete project.videoClips;
    files['project.json']=Buffer.from(JSON.stringify(project));const manifest=JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'));manifest.schemaVersion=1;
    manifest.files=Object.entries(files).filter(([name])=>name!=='manifest.json').map(([name,data])=>({name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}));files['manifest.json']=Buffer.from(JSON.stringify(manifest));
    const restored=await importProjectArchive(f.backend,{dataBase64:Buffer.from(zipSync(files)).toString('base64')});assert.equal(restored.project!.schemaVersion,2);assert.deepEqual(restored.project!.shotOrder,project.shotOrder);
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:bytes.subarray(0,-22).toString('base64')}),/截断|目录损坏/);
    assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,2);
  }finally{await f.close();}
});


test('archive limits are validated and enforced during stream output, compressed input and expansion',async()=>{
  const f=await fixture();try{
    const project=await f.backend.call<StudioSnapshot>('create',{title:'可配置限额'}),exported=await exportProjectArchive(f.backend,{projectId:project.project!.id}),bytes=Buffer.from(exported.dataBase64!,'base64');
    const files=unzipSync(bytes),contentBytes=Object.entries(files).filter(([name])=>name!=='manifest.json').reduce((sum,[,file])=>sum+file.length,0),destination=join(f.directory,'limited.yingliu');
    await writeFile(destination,'existing backup stays intact');
    await assert.rejects(exportProjectArchive(f.backend,{projectId:project.project!.id,path:destination,limits:{totalBytes:contentBytes+1}}),/输出超过总量限额/);
    assert.equal(await readFile(destination,'utf8'),'existing backup stays intact');assert.equal((await readdir(f.directory)).some(name=>name.includes('.tmp-')),false);
    await assert.rejects(exportProjectArchive(f.backend,{projectId:project.project!.id,limits:{fileBytes:16}}),/安全大小限额/);
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:exported.dataBase64,limits:{totalBytes:bytes.length-1}}),/输入超过总量限额/);
    const packed=Buffer.from(zipSync({'assets/expanded.bin':new Uint8Array(64*1024)})).toString('base64');
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:packed,limits:{totalBytes:32*1024}}),/解压后超过安全大小限额/);
    await assert.rejects(importProjectArchive(f.backend,{dataBase64:packed,limits:{fileBytes:32*1024}}),/单文件超过安全大小限额/);
    for(const limits of [{fileBytes:0},{fileBytes:-1},{fileBytes:1.5},{fileBytes:512*1024*1024+1},{totalBytes:4*1024*1024*1024},{totalBytes:NaN}]){
      await assert.rejects(exportProjectArchive(f.backend,{projectId:project.project!.id,limits}),/限额/);
      await assert.rejects(importProjectArchive(f.backend,{dataBase64:exported.dataBase64,limits}),/限额/);
    }
    const restored=await importProjectArchive(f.backend,{dataBase64:exported.dataBase64,limits:{fileBytes:64*1024,totalBytes:bytes.length}});assert.ok(restored.project);
    assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,2);
  }finally{await f.close();}
});

test('portable export remains pinned when another edit commits after the snapshot is read',async()=>{
 const f=await fixture();try{
  const initial=await f.backend.call<StudioSnapshot>('create',{title:'固定版本导出'}),id=initial.project!.id,shotId=initial.project!.shots[0]!.id;
  const original=await f.backend.call('source',{projectId:id,shotId});let captured=false;
  const backend={route:f.backend.route.bind(f.backend),call:async<T=StudioSnapshot>(endpoint:string,payload:unknown={})=>{
    const value=await f.backend.call<T>(endpoint,payload);
    if(endpoint==='current'&&!captured){captured=true;await f.backend.call('apply',{projectId:id,expectedRevision:0,title:'稍后更新',sources:[{shotId,source:{...defaultSceneSource(),css:'body { color: red; }'}}]});}
    return value;
  }};
  const archive=await exportProjectArchive(backend,{projectId:id}),files=unzipSync(Buffer.from(archive.dataBase64!,'base64'));
  assert.equal(JSON.parse(Buffer.from(files['project.json']!).toString()).revision,0);
  assert.deepEqual(JSON.parse(Buffer.from(files['sources/'+shotId+'.json']!).toString()),original);
  assert.equal((await f.backend.call<StudioSnapshot>('current',{projectId:id})).project!.revision,1);
 }finally{await f.close();}
});

test('archive import retries preserve the user operation ID across temporary extraction directories',async()=>{
 const f=await fixture();try{
  const original=await f.backend.call<StudioSnapshot>('create',{title:'导入去重'}),archive=await exportProjectArchive(f.backend,{projectId:original.project!.id});
  const input={dataBase64:archive.dataBase64!,operationId:'archive-import-once',expectedRevision:null};
  const first=await importProjectArchive(f.backend,input),second=await importProjectArchive(f.backend,input);
  assert.equal(first.project!.id,second.project!.id);assert.equal(first.project!.revision,0);
  assert.equal((await f.backend.operationReceipt(first.project!.id,input.operationId))!.committedRevision,0);
  assert.equal((await f.backend.call<{projects:unknown[]}>('list')).projects.length,2);
 }finally{await f.close();}
});
