import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {validateProject,compileSpec} from '../core/index.ts';
import {candidateHash} from '../agent/repository.ts';
import {AgentDatabase} from '../agent/database.ts';
import type {ValidationReceipt} from '../agent/contracts.ts';
import type {SceneSource,VideoProject,EnvironmentSettings} from '../shared/types.ts';
import {ProjectStore,projectPath,validateStoredProject} from './store.ts';
import {VideoRenderer} from './renderer.ts';

export interface CandidateInput {project:VideoProject;sources:Record<string,SceneSource>}
export {contentHash as inputHash} from '../agent/repository.ts';
const schema='CREATE TABLE IF NOT EXISTS host_validation_receipts (id TEXT PRIMARY KEY, candidate_hash TEXT NOT NULL, receipt_json TEXT NOT NULL)';
function syntax(js:string,signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--check','--input-type=module'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','ignore','pipe'],signal});
    let errors='';child.stderr.on('data',chunk=>{if(errors.length<8000)errors+=String(chunk);});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(errors||'镜头源码语法无效')));child.stdin.on('error',()=>{});child.stdin.end(js);
  });
}
export async function validateCandidate(input:CandidateInput,root:string|undefined,databasePath:string,store:ProjectStore,renderer:VideoRenderer,settings:EnvironmentSettings,signal?:AbortSignal):Promise<ValidationReceipt>{
  signal?.throwIfAborted();const candidate=structuredClone(input),checks:ValidationReceipt['checks']=[],frames:ValidationReceipt['frames']=[];
  // Full source content is part of the receipt identity, including unchanged shots.
  for(const shot of candidate.project.shots??[])if(!candidate.sources[shot.id]&&root)candidate.sources[shot.id]=await store.readSource(root,shot,candidate.project.revision);
  const receipt:ValidationReceipt={id:randomUUID(),candidateHash:candidateHash(candidate),baseRevision:candidate.project.revision,status:'failed',checks,frames,createdAt:new Date().toISOString(),validatorVersion:'studio-candidate-v1'};
  const check=async(id:string,work:()=>void|Promise<void>)=>{try{signal?.throwIfAborted();await work();checks.push({id,status:'passed'});}catch(error){signal?.throwIfAborted();checks.push({id,status:'failed',message:error instanceof Error?error.message:String(error)});}};
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
  const db=new AgentDatabase(databasePath);try{await db.transaction([{sql:schema},{sql:'INSERT INTO host_validation_receipts(id,candidate_hash,receipt_json) VALUES(?,?,?)',params:[receipt.id,receipt.candidateHash,JSON.stringify(receipt)]}]);}finally{await db.close();}
  return receipt;
}
export async function readValidation(databasePath:string,id:string):Promise<ValidationReceipt|undefined>{
  const db=new AgentDatabase(databasePath);try{await db.transaction([{sql:schema}]);const rows=await db.query<{receipt_json:string}>('SELECT receipt_json FROM host_validation_receipts WHERE id=?',[id]);return rows[0]?JSON.parse(rows[0].receipt_json):undefined;}finally{await db.close();}
}
