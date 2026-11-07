import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {projectOpenPath} from '../src/host/file-opener.ts';
import {StudioService} from '../src/host/service.ts';
import type {StudioSnapshot} from '../src/shared/types.ts';
import {createFileSymlinkOrSkip} from './fixtures/symlink.ts';

const directory={isDirectory:()=>true,isSymbolicLink:()=>false};
const virtualFs={lstat:async()=>directory,realpath:async(file:string)=>file};

test('project paths accept Windows casing, drive roots and UNC; reject sibling folders and other drives',async()=>{
  const options={platform:'win32' as const,fileSystem:virtualFs};
  assert.equal(await projectOpenPath('C:\\视频工程','c:\\视频工程\\exports\\成片 01.mp4',options),'c:\\视频工程\\exports\\成片 01.mp4');
  assert.equal(await projectOpenPath('C:\\视频工程\\','C:\\视频工程',options),'C:\\视频工程');
  assert.equal(await projectOpenPath('\\\\server\\share\\工程','\\\\server\\share\\工程\\成片.mp4',options),'\\\\server\\share\\工程\\成片.mp4');
  for(const target of ['C:\\视频工程-other\\成片.mp4','C:\\视频工程\\..\\外部.mp4','D:\\视频工程\\成片.mp4','\\\\server\\other\\工程\\成片.mp4']){
    await assert.rejects(projectOpenPath('C:\\视频工程',target,options),{code:'PATH_OUTSIDE_PROJECT'});
  }
  await assert.rejects(projectOpenPath('\\\\server\\share\\工程','\\\\server\\share\\工程-other\\成片.mp4',options),{code:'PATH_OUTSIDE_PROJECT'});
});

test('project directory and Chinese filenames are resolved without interpreting filename characters',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'yingliu-reveal-name-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'成片 $(echo injected); &.mp4');await writeFile(file,'fixture');
  assert.equal(await projectOpenPath(root),await realpath(root));
  assert.equal(await projectOpenPath(root,file),await realpath(file));
  await assert.rejects(projectOpenPath(root,path.join(root,'missing.mp4')),{code:'ENOENT'});
});

test('project boundaries reject external targets, directory links and linked project roots',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'yingliu-reveal-boundary-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=path.join(base,'工程 空格'),outside=path.join(base,'工程 空格-other');
  await mkdir(root);await mkdir(outside);await writeFile(path.join(outside,'成片.mp4'),'fixture');
  await symlink(outside,path.join(root,'linked-folder'),process.platform==='win32'?'junction':'dir');
  for(const target of [path.join(outside,'成片.mp4'),path.join(root,'linked-folder','成片.mp4')]){
    await assert.rejects(projectOpenPath(root,target),{code:'PATH_OUTSIDE_PROJECT'});
  }
  const linkedRoot=path.join(base,'linked-project');
  await symlink(root,linkedRoot,process.platform==='win32'?'junction':'dir');
  await assert.rejects(projectOpenPath(linkedRoot),{code:'PATH_OUTSIDE_PROJECT'});
});

test('file symlinks can reveal verified project-local destinations but cannot escape',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'yingliu-reveal-file-link-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const root=path.join(base,'工程'),inside=path.join(root,'成片.mp4'),outside=path.join(base,'外部.mp4');
  await mkdir(root);await writeFile(inside,'fixture');await writeFile(outside,'fixture');
  const internalLink=path.join(root,'内部链接.mp4'),externalLink=path.join(root,'外部链接.mp4');
  if(!await createFileSymlinkOrSkip(t,inside,internalLink))return;
  if(!await createFileSymlinkOrSkip(t,outside,externalLink))return;
  assert.equal(await projectOpenPath(root,internalLink),await realpath(inside));
  await assert.rejects(projectOpenPath(root,externalLink),{code:'PATH_OUTSIDE_PROJECT'});
});

test('reveal RPC hands Electron only verified project paths and reports broken or escaping links',async t=>{
  const base=await mkdtemp(path.join(tmpdir(),'yingliu-reveal-service-')),revealed:string[]=[];
  const service=new StudioService({
    llm:{listProviders:()=>[],listModels:async()=>[],async *stream(){throw new Error('This path test does not invoke a model');}},
    credentials:{async get(){return undefined;},async set(){},async delete(){}},
    reveal:async file=>{revealed.push(file);},
  },{baseDirectory:base,restoreRecent:false});
  service.renderer.preview=async()=> 'http://127.0.0.1:1/index.html';
  service.renderer.assetBaseUrl=async()=> 'http://127.0.0.1:1/';
  service.renderer.audioPreview=async()=>null;
  t.after(async()=>{await service.dispose();await rm(base,{recursive:true,force:true});});
  const created=await service.rpc('create',{title:'打开路径测试',blank:true});
  assert.equal(created.ok,true);if(!created.ok)return;
  const root=(created.value as StudioSnapshot).root!,file=path.join(root,'成片 空格.mp4');await writeFile(file,'fixture');
  assert.equal((await service.rpc('reveal',{path:file})).ok,true);
  assert.equal((await service.rpc('reveal',{})).ok,true);
  assert.deepEqual(revealed,[await realpath(file),await realpath(root)]);
  const outside=path.join(base,'outside');await mkdir(outside);await writeFile(path.join(outside,'成片.mp4'),'fixture');
  await symlink(outside,path.join(root,'linked-folder'),process.platform==='win32'?'junction':'dir');
  for(const target of [path.join(outside,'成片.mp4'),path.join(root,'linked-folder','成片.mp4')]){
    const response=await service.rpc('reveal',{path:target});assert.equal(response.ok,false);if(!response.ok)assert.equal(response.error.code,'PATH_OUTSIDE_PROJECT');
  }
  const missing=await service.rpc('reveal',{path:path.join(root,'missing.mp4')});assert.equal(missing.ok,false);if(!missing.ok)assert.equal(missing.error.code,'ENOENT');
  assert.equal(revealed.length,2);
});
