import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateProject,compileSpec} from '../core/index.ts';
import {candidateHash} from '../agent/repository.ts';
import {AgentDatabase} from '../agent/database.ts';
import type {ValidationReceipt} from '../agent/contracts.ts';
import type {SceneSource,VideoProject,EnvironmentSettings} from '../shared/types.ts';
import {ProjectStore,projectPath,validateStoredProject} from './store.ts';
import {validatePhase,VideoRenderer} from './renderer.ts';

export interface CandidateInput {project:VideoProject;sources:Record<string,SceneSource>}
export {contentHash as inputHash} from '../agent/repository.ts';
const schema='CREATE TABLE IF NOT EXISTS host_validation_receipts (id TEXT PRIMARY KEY, candidate_hash TEXT NOT NULL, receipt_json TEXT NOT NULL)';
function syntax(js:string,signal?:AbortSignal):Promise<void>{
  // Windows often never delivers stdin EOF to `node --check`, so the child waits forever and验收停在 validating。
  return mkdtemp(join(tmpdir(),'yingliu-syntax-')).then(directory=>new Promise<void>((resolve,reject)=>{
    const file=join(directory,'scene.mjs');let settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);void rm(directory,{recursive:true,force:true});error?reject(error):resolve();};
    const timer=setTimeout(()=>{child?.kill('SIGKILL');finish(new Error('镜头源码语法检查超时'));},10_000);
    let child:ReturnType<typeof spawn>|undefined;
    writeFile(file,js).then(()=>{
      if(signal?.aborted){finish(new Error('Task cancelled'));return;}
      child=spawn(process.execPath,['--check',file],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe'],windowsHide:true,signal});
      let errors='';child.stderr?.on('data',chunk=>{if(errors.length<8000)errors+=String(chunk);});
      child.once('error',error=>finish(error));
      child.once('close',code=>finish(code===0?undefined:new Error(errors||'镜头源码语法无效')));
    }).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
  }));
}
export async function validateCandidate(input:CandidateInput,root:string|undefined,databasePath:string,store:ProjectStore,renderer:VideoRenderer,settings:EnvironmentSettings,signal?:AbortSignal):Promise<ValidationReceipt>{
  signal?.throwIfAborted();const candidate=structuredClone(input),checks:ValidationReceipt['checks']=[],frames:ValidationReceipt['frames']=[];
  // Full source content is part of the receipt identity, including unchanged shots.
  for(const shot of candidate.project.shots??[])if(!candidate.sources[shot.id]&&root)candidate.sources[shot.id]=await store.readSource(root,shot,candidate.project.revision);
  const receipt:ValidationReceipt={id:randomUUID(),candidateHash:candidateHash(candidate),baseRevision:candidate.project.revision,status:'failed',checks,frames,createdAt:new Date().toISOString(),validatorVersion:'studio-candidate-v1'};
  const check=async(id:string,work:()=>void|Promise<void>)=>{validatePhase(id,'start');try{signal?.throwIfAborted();await work();checks.push({id,status:'passed'});validatePhase(id,'end passed');}catch(error){signal?.throwIfAborted();const message=error instanceof Error?error.message:String(error);checks.push({id,status:'failed',message});validatePhase(id,'end failed '+message);}};
  await check('structure',()=>{validateStoredProject(candidate.project);const result=validateProject(candidate.project);if(!result.ok)throw new Error(result.errors.join('\n'));compileSpec(candidate.project);});
  await check('syntax',async()=>{for(const shot of candidate.project.shots){const source=candidate.sources[shot.id];if(!source||typeof source.html!=='string'||typeof source.css!=='string'||typeof source.js!=='string')throw new Error('候选缺少完整源码：'+shot.id);await syntax(source.js,signal);}});
  await check('assets',async()=>{for(const asset of candidate.project.assets)for(const file of [asset.path,asset.originalPath])if(file){if(!root)throw new Error('新工程候选引用尚未导入的素材：'+file);if(!(await stat(await projectPath(root,file))).isFile())throw new Error('素材不可读：'+file);}});
  if(checks.every(check=>check.status==='passed'))await check('runtime',async()=>{
    const result=await renderer.checkCandidate(root,candidate.project,candidate.sources,settings,signal);frames.push(...result.frames.map(({frame,sha256})=>({frame,sha256})));
    if(!result.ok)throw new Error(result.errors.map(error=>error.message).join('\n'));
  });
  else checks.push({id:'runtime',status:'failed',message:'前置校验未通过，未启动浏览器'});
  if(candidate.project.target.audioMode==='mixed'&&((candidate.project.audioClips?.length??0)>0||candidate.project.videoClips?.some(clip=>clip.audio==='keep')))await check('audio-decode-mix',async()=>{
    if(!root)throw new Error('音频候选缺少素材所在工程');
    // FFmpeg reads every selected input and renders the full mix; this is technical audio QA, not a subjective verdict.
    await renderer.checkCandidateAudio(root,candidate.project,settings,signal);
  });
  receipt.status=checks.every(check=>check.status==='passed')?'passed':'failed';
  validatePhase('receipt','start');
  const db=new AgentDatabase(databasePath);
  try{await db.transaction([{sql:schema},{sql:'INSERT INTO host_validation_receipts(id,candidate_hash,receipt_json) VALUES(?,?,?)',params:[receipt.id,receipt.candidateHash,JSON.stringify(receipt)]}]);validatePhase('receipt','end');}
  catch(error){validatePhase('receipt','failed '+(error instanceof Error?error.message:String(error)));throw error;}
  finally{await db.close();}
  return receipt;
}
export async function readValidation(databasePath:string,id:string):Promise<ValidationReceipt|undefined>{
  const db=new AgentDatabase(databasePath);try{await db.transaction([{sql:schema}]);const rows=await db.query<{receipt_json:string}>('SELECT receipt_json FROM host_validation_receipts WHERE id=?',[id]);return rows[0]?JSON.parse(rows[0].receipt_json):undefined;}finally{await db.close();}
}
