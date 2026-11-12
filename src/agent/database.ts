import {execFileSync,fork,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface DatabaseStatement {sql:string;params?:unknown[];expectChanges?:number}
export interface DatabaseResult {rows?:unknown[];changes?:number}

interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void}
interface Pool {
  key:string;
  child:ChildProcess;
  processId?:number;
  users:number;
  sequence:number;
  pending:Map<number,Pending>;
  dead:boolean;
  stopping?:Promise<void>;
}

const pools=new Map<string,Pool>();

function workerFilename():string {
  // The source module, bundled web server and bundled Electron main have different roots.
  const directory=typeof __dirname==='string'?__dirname:dirname(fileURLToPath(import.meta.url));
  for(const candidate of [join(directory,'sqlite-worker.mjs'),join(directory,'agent/sqlite-worker.mjs'),join(directory,'../agent/sqlite-worker.mjs')])if(existsSync(candidate))return candidate;
  throw Object.assign(new Error('SQLite worker is missing from the application package'),{code:'DATABASE_WORKER_MISSING'});
}

function canonical(filename:string):string {
  const resolved=resolve(filename),name=basename(resolved),missing:string[]=[];
  let directory=dirname(resolved);
  while(!existsSync(directory)){
    missing.push(basename(directory));
    const parent=dirname(directory);
    if(parent===directory)break;
    directory=parent;
  }
  try{directory=realpathSync(directory);}catch{return resolved;}
  for(const part of missing.reverse())directory=join(directory,part);
  return join(directory,name);
}
function forceStop(pid:number){
  // taskkill /T runs before the process exits, so Windows children cannot keep the database open.
  if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:8000});}catch{/* the process already exited */}}
  try{process.kill(pid,'SIGKILL');}catch{/* the process already exited */}
}

function failPending(pool:Pool,error:Error){for(const request of pool.pending.values())request.reject(error);pool.pending.clear();}

function createPool(key:string,filename:string):Pool {
  const child=fork(workerFilename(),[filename],{execArgv:[],stdio:['ignore','ignore','inherit','ipc'],serialization:'advanced'});
  const pool:Pool={key,child,processId:child.pid,users:0,sequence:0,pending:new Map(),dead:false};
  child.on('message',(message:{id:number;value?:unknown;error?:{message:string;code?:string;errcode?:number;statementIndex?:number}})=>{
    const request=pool.pending.get(message.id);if(!request)return;pool.pending.delete(message.id);
    if(message.error)request.reject(Object.assign(new Error(message.error.message),{code:message.error.code??'DATABASE_ERROR',errcode:message.error.errcode,statementIndex:message.error.statementIndex}));else request.resolve(message.value);
    if(!pool.pending.size)child.unref();
  });
  child.on('error',error=>failPending(pool,error));
  child.on('exit',code=>{pool.dead=true;if(pools.get(key)===pool)pools.delete(key);if(pool.pending.size)failPending(pool,Object.assign(new Error(`SQLite worker exited (${code})`),{code:'DATABASE_WORKER_EXIT'}));});
  child.unref();return pool;
}

function acquire(key:string,filename:string):Pool {
  let pool=pools.get(key);
  if(!pool||pool.dead||pool.child.exitCode!==null||pool.child.signalCode!==null){pool=createPool(key,filename);pools.set(key,pool);}
  pool.users++;return pool;
}

function delay(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}
function shutdown(pool:Pool):Promise<void> {
  if(pool.stopping)return pool.stopping;
  pool.dead=true;if(pools.get(pool.key)===pool)pools.delete(pool.key);
  return pool.stopping=(async()=>{
    const child=pool.child,id=++pool.sequence;
    const closed=new Promise<void>(resolve=>{pool.pending.set(id,{resolve:()=>resolve(),reject:()=>resolve()});});
    try{child.send({id,kind:'close',payload:null});}catch{/* the process is already gone */}
    await Promise.race([closed,delay(1500)]);
    const exited=new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',()=>resolve());});
    if(pool.processId)forceStop(pool.processId);
    if(process.platform==='win32'&&child.exitCode===null&&child.signalCode===null&&!pool.key.startsWith(':memory:')){
      try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:YL_SQLITE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],{env:{...process.env,YL_SQLITE:pool.key},stdio:'ignore',windowsHide:true,timeout:8000});}catch{/* no matching process */}}
    await Promise.race([exited,delay(3000)]);
    child.unref();try{child.disconnect();}catch{/* the IPC channel is already gone */}
    failPending(pool,Object.assign(new Error('Database has been closed'),{code:'DATABASE_CLOSED'}));
    if(child.exitCode===null&&child.signalCode===null)throw Object.assign(new Error('SQLite process '+(pool.processId??'')+' is still running'),{code:'DATABASE_WORKER_EXIT'});
  })();
}

function stopWorkersUnder(directory:string){
  if(process.platform!=='win32')return;
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:YL_SQLITE_DIR) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'],{env:{...process.env,YL_SQLITE_DIR:directory},stdio:'ignore',windowsHide:true,timeout:8000});}catch{/* no matching process */}}

/** Ends every database process started in this process, then deletes a temp directory once Windows drops the file lock. */
export async function disposeDatabases(directory?:string):Promise<void>{
  const current=[...pools.values()];
  for(const pool of current)pool.users=0;
  await Promise.all(current.map(pool=>shutdown(pool)));
  if(directory)stopWorkersUnder(directory);
}
export async function removeDirectory(directory:string):Promise<void>{
  await disposeDatabases(directory);
  const {rm}=await import('node:fs/promises');
  let last:unknown;
  for(let attempt=0;attempt<20;attempt++){
    try{await rm(directory,{recursive:true,force:true,maxRetries:0});return;}
    catch(error){last=error;const code=(error as NodeJS.ErrnoException).code;if(code!=='EBUSY'&&code!=='EPERM'&&code!=='ENOTEMPTY')throw error;await delay(200);}
  }
  throw last;
}

/** One child process per database file. A second handle shares that process so Windows does not keep two locks. */
export class AgentDatabase {
  readonly filename:string;
  private readonly key:string;
  private pool?:Pool;
  private closed=false;
  private closing?:Promise<void>;
  constructor(filename:string){
    if(filename===':memory:'){this.filename=filename;this.key=':memory:'+randomUUID();}
    else{this.filename=canonical(filename);this.key=this.filename;}
  }
  private ensure():Pool {
    if(this.closed)throw Object.assign(new Error('Database has been closed'),{code:'DATABASE_CLOSED'});
    if(!this.pool||this.pool.dead)this.pool=acquire(this.key,this.filename);
    return this.pool;
  }
  private request(kind:'query'|'transaction',payload:unknown,attempt=0):Promise<unknown>{
    const pool=this.ensure(),id=++pool.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(!pool.pending.has(id))return;pool.pending.delete(id);if(!pool.pending.size)pool.child.unref();reject(Object.assign(new Error('Database request timed out'),{code:'DATABASE_TIMEOUT'}));},30_000);
      const finish=(ok:boolean,value:unknown)=>{clearTimeout(timer);ok?resolve(value):reject(value as Error);};
      pool.pending.set(id,{resolve:value=>finish(true,value),reject:error=>finish(false,error)});pool.child.ref();
      try{pool.child.send({id,kind,payload});}
      catch(error){pool.pending.delete(id);clearTimeout(timer);if(!pool.pending.size)pool.child.unref();const failed=error instanceof Error?error:new Error(String(error));if(attempt<1&&(failed as NodeJS.ErrnoException).code==='EPIPE'){pool.dead=true;if(pools.get(pool.key)===pool)pools.delete(pool.key);this.pool=undefined;resolve(this.request(kind,payload,attempt+1));return;}reject(failed);}
    });
  }
  async query<T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T[]>{return await this.request('query',{sql,params}) as T[];}
  async transaction(statements:DatabaseStatement[]):Promise<DatabaseResult[]>{return await this.request('transaction',statements) as DatabaseResult[];}
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;
    const pool=this.pool;this.pool=undefined;
    if(!pool)return this.closing=Promise.resolve();
    pool.users=Math.max(0,pool.users-1);
    if(pool.users>0)return this.closing=Promise.resolve();
    return this.closing=shutdown(pool);
  }
}
