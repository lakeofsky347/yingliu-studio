import {Worker} from 'node:worker_threads';
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

/** Async facade: all synchronous SQLite work and lock waiting happen in a worker. */
export class AgentDatabase {
  readonly filename:string;
  private worker?:Worker;
  private sequence=0;
  private closed=false;
  private closing?:Promise<void>;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  constructor(filename:string){this.filename=filename===':memory:'?filename:resolve(filename);}
  private start():Worker {
    if(this.worker)return this.worker;
    const worker=new Worker(workerFilename(),{workerData:{filename:this.filename},execArgv:[]});this.worker=worker;
    worker.on('message',(message:{id:number;value?:unknown;error?:{message:string;code?:string;errcode?:number;statementIndex?:number}})=>{
      const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);
      if(message.error)request.reject(Object.assign(new Error(message.error.message),{code:message.error.code??'DATABASE_ERROR',errcode:message.error.errcode,statementIndex:message.error.statementIndex}));else request.resolve(message.value);
      if(!this.pending.size)worker.unref();
    });
    const failed=(error:Error)=>{if(this.worker===worker)this.worker=undefined;for(const request of this.pending.values())request.reject(error);this.pending.clear();};
    worker.on('error',failed);
    worker.on('exit',code=>{if(this.worker===worker){this.worker=undefined;if(this.pending.size)failed(Object.assign(new Error(`SQLite worker exited (${code})`),{code:'DATABASE_WORKER_EXIT'}));}});
    worker.unref();return worker;
  }
  private request(kind:'query'|'transaction'|'close',payload:unknown):Promise<unknown>{
    if(this.closed&&kind!=='close')return Promise.reject(Object.assign(new Error('Database has been closed'),{code:'DATABASE_CLOSED'}));
    const worker=this.start(),id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});worker.ref();try{worker.postMessage({id,kind,payload});}catch(error){this.pending.delete(id);if(!this.pending.size)worker.unref();reject(error);}});
  }
  async query<T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T[]>{return await this.request('query',{sql,params}) as T[];}
  async transaction(statements:DatabaseStatement[]):Promise<DatabaseResult[]>{return await this.request('transaction',statements) as DatabaseResult[];}
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;
    return this.closing=(async()=>{
      const worker=this.worker;if(!worker)return;
      const exited=new Promise<void>(resolve=>{worker.once('exit',()=>resolve());});
      try{await this.request('close',null);}catch{/* the worker may already have exited */}
      const finished=await Promise.race([exited.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),2000))]);
      if(!finished)await worker.terminate();
      await exited;
      if(this.worker===worker)this.worker=undefined;
    })();
  }
}
