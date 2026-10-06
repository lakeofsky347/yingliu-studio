import { zip, Unzip, UnzipInflate } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { projectPath } from '../host/store.ts';
import type { BackendPort } from './contracts.ts';
import type { SceneSource, StudioSnapshot, VideoProject } from '../shared/types.ts';
const LIMIT=96*1024*1024,FILE_LIMIT=24*1024*1024;
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=(value:unknown)=>Buffer.from(JSON.stringify(value));
function allowed(name:string){return name==='manifest.json'||name==='project.json'||/^sources\/[\w-]{1,100}\.json$/.test(name)||/^assets\/[\w./-]+$/.test(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..');}
async function zipFiles(files:Record<string,Uint8Array>):Promise<Uint8Array>{return new Promise((accept,reject)=>zip(files,{level:6},(error,result)=>error?reject(error):accept(result)));}
/** Streaming inflate bounds real output size even when a ZIP lies about its header. */
async function unzipFiles(bytes:Uint8Array):Promise<Record<string,Uint8Array>>{
  if(bytes.byteLength>LIMIT)throw new Error('工程包超过 96 MiB');
  const files:Record<string,Uint8Array>={};let total=0,count=0,failure:Error|undefined;const pending:Promise<void>[]=[];
  const unzip=new Unzip(file=>{
    if(++count>256||!allowed(file.name)||Object.hasOwn(files,file.name)){failure=new Error('工程包含不支持、重复或不安全的路径');return;}
    files[file.name]=new Uint8Array();
    if((file.originalSize??0)>FILE_LIMIT){failure=new Error('工程包单文件超过 24 MiB');return;}
    pending.push(new Promise((accept,reject)=>{const chunks:Uint8Array[]=[];let size=0;
      file.ondata=(error,chunk,final)=>{if(error){reject(error);return;}size+=chunk.length;total+=chunk.length;
        if(size>FILE_LIMIT||total>LIMIT){file.terminate();reject(new Error('工程包解压后超过安全大小限制'));return;}
        chunks.push(chunk);if(final){const result=new Uint8Array(size);let offset=0;for(const part of chunks){result.set(part,offset);offset+=part.length;}files[file.name]=result;accept();}
      };file.start();
    }));
  });unzip.register(UnzipInflate);unzip.push(bytes,true);await Promise.all(pending);if(failure)throw failure;return files;
}
export async function exportProjectArchive(backend:BackendPort,input:{projectId?:string;path?:string}){
  const snapshot=await backend.call<StudioSnapshot>('current',{projectId:input.projectId});if(!snapshot.project||!snapshot.root)throw new Error('请先打开一个影片工程');
  const project=structuredClone(snapshot.project);project.outputs=[];delete project.sessionIds;
  project.extensions={...project.extensions};delete project.extensions.sessionIds;
  const files:Record<string,Uint8Array>={'project.json':json(project)};let total=0,assetBytes=0;
  for(const shot of project.shots){const source=await backend.call<SceneSource>('source',{projectId:project.id,shotId:shot.id});files['sources/'+shot.id+'.json']=json(source);}
  for(const asset of project.assets)if(asset.path&&!Object.hasOwn(files,asset.path)){if(!allowed(asset.path)||!asset.path.startsWith('assets/'))throw new Error('工程包含非素材目录的文件引用');const path=await projectPath(snapshot.root,asset.path);const size=(await stat(path)).size;if(size>FILE_LIMIT)throw new Error('素材 '+asset.name+' 超过工程包单文件限制');assetBytes+=size;if(assetBytes>64*1024*1024)throw new Error('工程素材超过 64 MiB，请减少素材后备份');files[asset.path]=await readFile(path);}
  for(const [name,bytes] of Object.entries(files)){if(bytes.length>FILE_LIMIT)throw new Error('素材 '+name+' 超过工程包单文件限制');total+=bytes.length;}if(total>LIMIT)throw new Error('工程素材超过 96 MiB，请减少素材后备份');
  const current=await backend.call<StudioSnapshot>('current',{projectId:project.id});if(current.project?.revision!==project.revision)throw new Error('备份期间工程发生变化，请等待保存后重试');
  files['manifest.json']=json({format:'yingliu-project',schemaVersion:1,appVersion:'0.2.0',createdAt:new Date().toISOString(),files:Object.entries(files).map(([name,bytes])=>({name,bytes:bytes.length,sha256:sha(bytes)}))});
  const archive=Buffer.from(await zipFiles(files)),name=(project.title.replace(/[<>:"/\\|?*]/g,'-')||'影片')+'.yingliu';
  if(input.path){await mkdir(dirname(input.path),{recursive:true});const temporary=input.path+'.tmp-'+randomUUID();await writeFile(temporary,archive);await rename(temporary,input.path);return {name,path:input.path,size:archive.length};}
  return {name,dataBase64:archive.toString('base64'),size:archive.length};
}
export async function importProjectArchive(backend:BackendPort,input:{path?:string;dataBase64?:string}):Promise<StudioSnapshot>{
  if(!input.path&&!input.dataBase64)throw new Error('请选择一个 .yingliu 工程包');
  if(input.path&&(await stat(input.path)).size>LIMIT||input.dataBase64&&input.dataBase64.length>Math.ceil(LIMIT*4/3)+4)throw new Error('工程包超过 96 MiB');
  const bytes=input.path?await readFile(input.path):Buffer.from(input.dataBase64!,'base64');const files=await unzipFiles(bytes);
  if(!files['manifest.json']||!files['project.json'])throw new Error('文件不是有效的映流工程包');
  const manifest=JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));if(manifest.format!=='yingliu-project'||manifest.schemaVersion!==1||!Array.isArray(manifest.files))throw new Error('不支持此工程包版本');
  if(manifest.files.length!==Object.keys(files).length-1)throw new Error('工程包清单不完整');
  const seen=new Set<string>();for(const entry of manifest.files){if(typeof entry.name!=='string'||seen.has(entry.name)||entry.name==='manifest.json'||!allowed(entry.name))throw new Error('工程包清单路径无效');seen.add(entry.name);const file=files[entry.name];if(!file||entry.bytes!==file.length||entry.sha256!==sha(file))throw new Error('工程包内容损坏：'+entry.name);}
  const project=JSON.parse(Buffer.from(files['project.json']).toString('utf8')) as VideoProject;if(project.schemaVersion!==1||!Array.isArray(project.shots)||!Array.isArray(project.assets))throw new Error('工程数据格式无效');
  project.id='film-'+randomUUID();project.revision=0;project.outputs=[];delete project.sessionIds;project.extensions={...project.extensions};delete project.extensions.sessionIds;project.createdAt=project.updatedAt=new Date().toISOString();
  const sources=project.shots.map(shot=>{const data=files['sources/'+shot.id+'.json'];if(!data)throw new Error('工程包缺少镜头源码');return {shotId:shot.id,source:JSON.parse(Buffer.from(data).toString('utf8')) as SceneSource};});
  const assetFiles=[...new Set(project.assets.flatMap(asset=>asset.path?[asset.path]:[]))].map(path=>{if(!allowed(path)||!path.startsWith('assets/'))throw new Error('素材路径无效');const data=files[path];if(!data)throw new Error('工程包缺少素材 '+path);return {path,dataBase64:Buffer.from(data).toString('base64')};});
  return backend.call('create',{project,sources,assetFiles});
}
