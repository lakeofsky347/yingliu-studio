import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
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
    const imported=await f.backend.call<StudioSnapshot>('import',{projectId:snapshot.project!.id,name:'fixture.png',mime:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='});const asset=imported.project!.assets[0]!;
    await rm(join(snapshot.root!,asset.path!));if(!await createFileSymlinkOrSkip(context,outside,join(snapshot.root!,asset.path!)))return;
    await assert.rejects(exportProjectArchive(f.backend,{projectId:snapshot.project!.id}),/符号|symlink|越界|本项目|路径/i);
  }finally{await f.close();}
});
test('application shutdown is idempotent and refuses new writes after draining',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-lifecycle-'));const app=await createApplication({dataDirectory:directory,credentials:new MemorySecrets()});
  try{const result=await app.route('create',{blank:true,title:'关闭生命周期'});assert.equal(result.ok,true);await Promise.all([app.dispose(),app.dispose()]);const late=await app.route('create',{blank:true});assert.ok(!late.ok);assert.equal(late.error.code,'APP_SHUTTING_DOWN');}
  finally{await app.dispose();await rm(directory,{recursive:true,force:true});}
});
