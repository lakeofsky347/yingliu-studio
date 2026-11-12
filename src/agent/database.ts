import {fork,type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export interface DatabaseStatement {sql:string;params?:unknown[];expectChanges?:number}
export interface DatabaseResult {rows?:unknown[];changes?:number}

function workerFilename():string {
  // The source module, bundled web server and bundled Electron main have different roots.
  const directory=typeof __dirname==='string'?__dirname:dirname(fileURLToPath(import.meta.url));
  for(const candidate of [join(directory,'sqlite-worker.mjs'),join(directory,'agent/sqlite-worker.mjs'),join(directory,'../agent/sqlite-worker.mjs')])if(existsSync(candidate))return candidate;
  throw Object.assign(new Error('SQLite worker is missing from the application package'),{code:'DATABASE_WORKER_MISSING'});
}

/** Async facade: SQLite runs in a child process so Windows releases the file when that process exits. */
export class AgentDatabase {
  readonly filename:string;
  private child?:ChildProcess;
  private sequence=0;
  private closed=false;
  private closing?:Promise<void>;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  constructor(filename:string){this.filename=filename===':memory:'?filename:resolve(filename);}
  private start():ChildProcess {
    if(this.child)return this.child;
    const child=fork(workerFilename(),[this.filename],{execArgv:[],stdio:['ignore','inherit','inherit','ipc'],serialization:'advanced'});this.child=child;
    child.on('message',(message:{id:number;value?:unknown;error?:{message:string;code?:string;errcode?:number;statementIndex?:number}})=>{
      const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);
      if(message.error)request.reject(Object.assign(new Error(message.error.message),{code:message.error.code??'DATABASE_ERROR',errcode:message.error.errcode,statementIndex:message.error.statementIndex}));else request.resolve(message.value);
      if(!this.pending.size)child.unref();
    });
    const failed=(error:Error)=>{if(this.child===child)this.child=undefined;for(const request of this.pending.values())request.reject(error);this.pending.clear();};
    child.on('error',failed);
    child.on('exit',code=>{if(this.child===child){this.child=undefined;if(this.pending.size)failed(Object.assign(new Error(`SQLite worker exited (${code})`),{code:'DATABASE_WORKER_EXIT'}));}});
    child.unref();return child;
  }
  private request(kind:'query'|'transaction'|'close',payload:unknown):Promise<unknown>{
    if(this.closed&&kind!=='close')return Promise.reject(Object.assign(new Error('Database has been closed'),{code:'DATABASE_CLOSED'}));
    const child=this.start(),id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});child.ref();try{child.send({id,kind,payload});}catch(error){this.pending.delete(id);if(!this.pending.size)child.unref();reject(error instanceof Error?error:new Error(String(error)));}});
  }
  async query<T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T[]>{return await this.request('query',{sql,params}) as T[];}
  async transaction(statements:DatabaseStatement[]):Promise<DatabaseResult[]>{return await this.request('transaction',statements) as DatabaseResult[];}
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;
    return this.closing=(async()=>{
      const child=this.child;if(!child)return;
      const exited=new Promise<void>(resolve=>{child.once('exit',()=>resolve());});
      const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
      await Promise.race([this.request('close',null).then(()=>undefined,()=>undefined),delay(5000)]);
      const finished=await Promise.race([exited.then(()=>true),delay(3000).then(()=>false)]);
      if(!finished)child.kill();
      await Promise.race([exited,delay(2000)]);
      if(this.child===child)this.child=undefined;
    })();
  }
}
