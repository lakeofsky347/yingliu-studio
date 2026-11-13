import { Zip, ZipPassThrough, Unzip, UnzipInflate } from 'fflate';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openSync, closeSync, writeSync, mkdirSync } from 'node:fs';
import { readFile, mkdir, rename, stat, mkdtemp, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {contentHash} from '../agent/repository.ts';
import { ProjectStore, projectPath, validateStoredProject } from '../host/store.ts';
import type { BackendPort } from './contracts.ts';
import type { Asset, SceneSource, StudioSnapshot, VideoProject } from '../shared/types.ts';

const MiB=1024*1024;
/** Reserve space for ZIP32 headers and central-directory entries below the 4 GiB format limit. */
const LIMIT=4*1024*MiB-MiB,FILE_LIMIT=512*MiB,METADATA_LIMIT=24*MiB,INLINE_LIMIT=64*MiB,ENTRY_LIMIT=256;
/** Per-operation budgets may only reduce the fixed transport/storage limits. Values are bytes. */
export interface ArchiveLimits {fileBytes?:number;totalBytes?:number}
interface ResolvedArchiveLimits {fileBytes:number;totalBytes:number}
function resolveLimits(input?:ArchiveLimits):ResolvedArchiveLimits{
  if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['fileBytes','totalBytes'].includes(key))))throw new Error('工程包限额配置无效');
  for(const key of ['fileBytes','totalBytes'] as const)if(input?.[key]!==undefined&&typeof input[key]!=='number')throw new Error('工程包限额 '+key+' 须为整数');
  const result={fileBytes:input?.fileBytes??FILE_LIMIT,totalBytes:input?.totalBytes??LIMIT};
  for(const [key,maximum] of [['fileBytes',FILE_LIMIT],['totalBytes',LIMIT]] as const)if(!Number.isSafeInteger(result[key])||result[key]<1||result[key]>maximum)throw new Error(`工程包限额 ${key} 须为 1–${maximum} 字节的整数，不能超过硬上限`);
  return result;
}
const json=(value:unknown)=>Buffer.from(JSON.stringify(value));
function assetPaths(asset:Asset):string[]{return [...new Set([asset.path,asset.originalPath].filter((value):value is string=>typeof value==='string'))];}
interface ArchiveEntry {name:string;bytes:number;sha256:string}
interface ExtractedEntry extends ArchiveEntry {path:string;complete:boolean}
function allowed(name:string){return name==='manifest.json'||name==='project.json'||/^sources\/[\w-]{1,100}\.json$/.test(name)||/^assets\/[\w./-]+$/.test(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..');}
function fileLimit(name:string,limits:ResolvedArchiveLimits){return name.startsWith('assets/')?limits.fileBytes:Math.min(limits.fileBytes,METADATA_LIMIT);}
function cleanProject(project:VideoProject):VideoProject{
  const value=structuredClone(project);value.outputs=[];delete value.sessionIds;
  value.extensions={...value.extensions};delete value.extensions.sessionIds;return value;
}

/** Write ZIP chunks immediately; media never passes through a whole-file buffer or JSON/base64. */
async function writeArchive(file:string,entries:{name:string;bytes?:Uint8Array;path?:string}[],manifest:{project:VideoProject},limits:ResolvedArchiveLimits):Promise<number>{
  const handle=await open(file,'wx'),pending:Uint8Array[]=[],records:ArchiveEntry[]=[];let error:Error|undefined,final=false,total=0,outputSize=0;
  const archive=new Zip((cause,chunk,finished)=>{if(cause){error=cause;return;}pending.push(chunk);if(finished)final=true;});
  const flush=async()=>{if(error)throw error;for(const chunk of pending.splice(0)){outputSize+=chunk.length;if(outputSize>limits.totalBytes)throw new Error('工程包输出超过总量限额 '+limits.totalBytes+' 字节');let written=0;while(written<chunk.length){const result=await handle.write(chunk,written,chunk.length-written);if(!result.bytesWritten)throw new Error('工程包写入失败');written+=result.bytesWritten;}}};
  const add=async(entry:{name:string;bytes?:Uint8Array;path?:string},record=true)=>{
    const stream=new ZipPassThrough(entry.name),hash=createHash('sha256');let size=0;archive.add(stream);await flush();
    const push=async(bytes:Uint8Array)=>{size+=bytes.length;total+=bytes.length;if(size>fileLimit(entry.name,limits)||total>limits.totalBytes)throw new Error('工程素材超过安全大小限额（单文件 '+limits.fileBytes+' 字节，总量 '+limits.totalBytes+' 字节）');hash.update(bytes);stream.push(bytes);await flush();};
    if(entry.bytes)await push(entry.bytes);
    else if(entry.path)for await(const bytes of createReadStream(entry.path,{highWaterMark:64*1024}))await push(bytes);
    stream.push(new Uint8Array(),true);await flush();if(record)records.push({name:entry.name,bytes:size,sha256:hash.digest('hex')});
  };
  try{
    for(const entry of entries)await add(entry);
    await add({name:'manifest.json',bytes:json({format:'yingliu-project',schemaVersion:2,projectSchemaVersion:manifest.project.schemaVersion,appVersion:'0.3.0',createdAt:new Date().toISOString(),files:records})},false);
    archive.end();await flush();if(!final)throw new Error('工程包未完成写入');await handle.sync();return outputSize;
  }finally{archive.terminate();await handle.close();}
}

/** Streaming inflate writes only into a fresh private staging directory, validating actual expanded sizes. */
async function extractArchive(input:{path?:string;dataBase64?:string},directory:string,limits:ResolvedArchiveLimits):Promise<Map<string,ExtractedEntry>>{
  const files=new Map<string,ExtractedEntry>(),handles=new Set<number>();let total=0,compressed=0,tail=Buffer.alloc(0);
  const consume=(bytes:Uint8Array)=>{compressed+=bytes.length;if(compressed>limits.totalBytes)throw new Error('工程包输入超过总量限额 '+limits.totalBytes+' 字节');tail=Buffer.concat([tail,bytes]).subarray(-65557);unzip.push(bytes);};
  const unzip=new Unzip(file=>{
    if(files.size>=ENTRY_LIMIT||!allowed(file.name)||files.has(file.name))throw new Error('工程包含不支持、重复或不安全的路径');
    const maximum=fileLimit(file.name,limits);if((file.originalSize??0)>maximum)throw new Error('工程包单文件超过安全大小限额 '+maximum+' 字节（元数据硬上限 24 MiB）');
    const destination=join(directory,...file.name.split('/'));mkdirSync(dirname(destination),{recursive:true});const fd=openSync(destination,'wx');handles.add(fd);
    const record:ExtractedEntry={name:file.name,path:destination,bytes:0,sha256:'',complete:false},hash=createHash('sha256');files.set(file.name,record);
    file.ondata=(error,chunk,final)=>{
      if(error)throw error;record.bytes+=chunk.length;total+=chunk.length;
      if(record.bytes>maximum||total>limits.totalBytes){file.terminate();throw new Error('工程包解压后超过安全大小限额');}
      hash.update(chunk);let offset=0;while(offset<chunk.length){const written=writeSync(fd,chunk,offset,chunk.length-offset);if(!written)throw new Error('工程包素材写入失败');offset+=written;}
      if(final){record.complete=true;record.sha256=hash.digest('hex');closeSync(fd);handles.delete(fd);}
    };file.start();
  });unzip.register(UnzipInflate);
  try{
    if(input.path){
      const info=await stat(input.path);if(!info.isFile()||info.size>limits.totalBytes)throw new Error('工程包文件超过总量限额 '+limits.totalBytes+' 字节');
      for await(const bytes of createReadStream(input.path,{highWaterMark:64*1024})){consume(bytes);}
    }else{
      const encoded=input.dataBase64!;if(encoded.length>Math.ceil(INLINE_LIMIT*4/3)+4)throw new Error('浏览器工程包传输上限为 64 MiB；大工程包请通过桌面应用选择本地文件');
      if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('工程包 base64 数据无效');
      const bytes=Buffer.from(encoded,'base64');if(bytes.length>INLINE_LIMIT)throw new Error('浏览器工程包传输超过 64 MiB');
      for(let offset=0;offset<bytes.length;offset+=64*1024)consume(bytes.subarray(offset,offset+64*1024));
    }
    unzip.push(new Uint8Array(),true);
    let end=-1;for(let offset=tail.length-22;offset>=0;offset--)if(tail.readUInt32LE(offset)===0x06054b50&&offset+22+tail.readUInt16LE(offset+20)===tail.length){end=offset;break;}
    if(end<0||tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0||tail.readUInt16LE(end+8)!==files.size||tail.readUInt16LE(end+10)!==files.size||tail.readUInt32LE(end+12)+tail.readUInt32LE(end+16)!==compressed-tail.length+end)throw new Error('工程包被截断或 ZIP 目录损坏');
    if([...files.values()].some(file=>!file.complete))throw new Error('工程包被截断，素材未完整解压');return files;
  }finally{for(const fd of handles)closeSync(fd);}
}

export async function exportProjectArchive(backend:BackendPort,input:{projectId?:string;path?:string;limits?:ArchiveLimits}){
  const limits=resolveLimits(input.limits);
  const snapshot=await backend.call<StudioSnapshot>('current',{projectId:input.projectId});if(!snapshot.project||!snapshot.root)throw new Error('请先打开一个影片工程');
  const project=cleanProject(snapshot.project);validateStoredProject(project);
  const entries:{name:string;bytes?:Uint8Array;path?:string}[]=[{name:'project.json',bytes:json(project)}],seen=new Set(['project.json']);let total=entries[0]!.bytes!.length;
  const store=new ProjectStore();
  for(const shot of project.shots){const source=await store.readSource(snapshot.root,shot,project.revision),bytes=json(source);entries.push({name:'sources/'+shot.id+'.json',bytes});total+=bytes.length;}
  for(const asset of project.assets)for(const relative of assetPaths(asset))if(!seen.has(relative)){
    if(!allowed(relative)||!relative.startsWith('assets/'))throw new Error('工程包含非素材目录的文件引用');const path=await projectPath(snapshot.root,relative),info=await stat(path);
    if(!info.isFile()||info.size>limits.fileBytes)throw new Error('素材 '+asset.name+' 超过工程包单文件限额 '+limits.fileBytes+' 字节');total+=info.size;seen.add(relative);entries.push({name:relative,path});
  }
  if(entries.length+1>ENTRY_LIMIT)throw new Error('工程包文件数量超过 256');if(total>limits.totalBytes)throw new Error('工程素材超过总量限额 '+limits.totalBytes+' 字节');
  if(!input.path&&total>INLINE_LIMIT-MiB)throw new Error('浏览器工程包传输上限为 64 MiB；大工程请使用桌面应用保存工程包');
  const temporaryDirectory=input.path?undefined:await mkdtemp(join(tmpdir(),'yingliu-export-')),destination=input.path??join(temporaryDirectory!,'project.yingliu'),temporary=destination+'.tmp-'+randomUUID();
  await mkdir(dirname(destination),{recursive:true});
  try{
    const size=await writeArchive(temporary,entries,{project},limits);
    // Sources and immutable assets were pinned to the captured revision above.
    const name=(project.title.replace(/[<>:"/\\|?*]/g,'-')||'影片')+'.yingliu';
    if(input.path){await rename(temporary,destination);return {name,path:destination,size};}
    if(size>INLINE_LIMIT)throw new Error('浏览器工程包传输超过 64 MiB；请使用桌面应用保存工程包');return {name,dataBase64:(await readFile(temporary)).toString('base64'),size};
  }finally{await rm(temporary,{force:true});if(temporaryDirectory)await rm(temporaryDirectory,{recursive:true,force:true});}
}

export async function importProjectArchive(backend:BackendPort,input:{path?:string;dataBase64?:string;limits?:ArchiveLimits;operationId?:string;expectedRevision?:null}):Promise<StudioSnapshot>{
  const limits=resolveLimits(input.limits);
  if(!input.path&&!input.dataBase64)throw new Error('请选择一个 .yingliu 工程包');
  if(input.path&&input.dataBase64)throw new Error('工程包文件和数据只能选择一种');
  const directory=await mkdtemp(join(tmpdir(),'yingliu-import-'));
  try{
    const files=await extractArchive(input,directory,limits),manifestFile=files.get('manifest.json'),projectFile=files.get('project.json');
    if(!manifestFile||!projectFile)throw new Error('文件不是有效的映流工程包');
    const manifest=JSON.parse(await readFile(manifestFile.path,'utf8'));if(manifest.format!=='yingliu-project'||![1,2].includes(manifest.schemaVersion)||!Array.isArray(manifest.files))throw new Error('不支持此工程包版本');
    if(manifest.files.length!==files.size-1)throw new Error('工程包清单不完整');
    const seen=new Set<string>();for(const entry of manifest.files){
      if(!entry||typeof entry.name!=='string'||seen.has(entry.name)||entry.name==='manifest.json'||!allowed(entry.name))throw new Error('工程包清单路径无效');seen.add(entry.name);
      const file=files.get(entry.name);if(!file||entry.bytes!==file.bytes||entry.sha256!==file.sha256)throw new Error('工程包内容损坏：'+entry.name);
    }
    const project=cleanProject(JSON.parse(await readFile(projectFile.path,'utf8')) as VideoProject);validateStoredProject(project);
    const operationId=input.operationId??randomUUID(),payloadHash=contentHash({kind:'archive.import',manifest,limits});
    project.id='film-'+contentHash({operationId}).slice(0,32);project.revision=0;
    const sources=[];for(const shot of project.shots){const entry=files.get('sources/'+shot.id+'.json');if(!entry)throw new Error('工程包缺少镜头源码');sources.push({shotId:shot.id,source:JSON.parse(await readFile(entry.path,'utf8')) as SceneSource});}
    const assetFiles=[...new Set(project.assets.flatMap(assetPaths))].map(path=>{if(!allowed(path)||!path.startsWith('assets/'))throw new Error('素材路径无效');const entry=files.get(path);if(!entry)throw new Error('工程包缺少素材 '+path);return {path,localPath:entry.path};});
    return await backend.call('create',{project,sources,assetFiles,operationId,expectedRevision:null,operation:{id:operationId,payloadHash}});
  }finally{await rm(directory,{recursive:true,force:true});}
}
