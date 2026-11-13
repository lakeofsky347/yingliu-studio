import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentDatabase } from '../agent/database.ts';

export function requestHash(value:unknown):string {
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)])):item;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
interface Row {kind:string;id:string;project_id:string;operation_id:string;request_hash:string;record_json:string;version:number;generation:number;owner:string|null;lease_until:number;stop_requested:number;status:string;connection_id:string|null}
export interface DurableRecord<T> {value:T;version:number;generation:number;owner:string|null;leaseUntil:number;stopRequested:boolean;operationId:string;requestHash:string}
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});

/** Project-local records and short leases; JSON files are import-only legacy data. */
export class DurableServiceRecords<T extends {id:string;projectId:string}> {
  readonly owner=randomUUID();
  private index:AgentDatabase;
  private initialized:Promise<void>;
  private databases=new Map<string,AgentDatabase>();
  private opening=new Map<string,Promise<AgentDatabase>>();
  private paths=new Map<string,string>();
  private locations=new Map<string,string>();
  private metadata=new Map<string,DurableRecord<T>>();
  constructor(directory:string,readonly kind:'workflow'|'media',private resolvePath:(projectId:string)=>Promise<string>){
    this.index=new AgentDatabase(join(directory,'agent-service-index.sqlite'));
    this.initialized=this.index.transaction([{sql:'CREATE TABLE IF NOT EXISTS service_locations (kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,database_path TEXT NOT NULL,PRIMARY KEY(kind,id))'}]).then(()=>{});
  }
  private async database(projectId:string):Promise<AgentDatabase>{
    const existing=this.databases.get(projectId);if(existing)return existing;
    let pending=this.opening.get(projectId);if(pending)return pending;
    pending=(async()=>{const path=this.paths.get(projectId)??await this.resolvePath(projectId),db=new AgentDatabase(path);await db.transaction([
      {sql:'CREATE TABLE IF NOT EXISTS service_records (kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,record_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,stop_requested INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,connection_id TEXT,PRIMARY KEY(kind,id),UNIQUE(kind,operation_id))'},
      {sql:'CREATE TABLE IF NOT EXISTS session_activity(session_id TEXT PRIMARY KEY,kind TEXT NOT NULL,task_id TEXT NOT NULL)'},
      {sql:'CREATE INDEX IF NOT EXISTS service_records_running ON service_records(kind,project_id,status,lease_until)'},
    ]);this.paths.set(projectId,path);this.databases.set(projectId,db);return db;})();this.opening.set(projectId,pending);
    try{return await pending;}finally{this.opening.delete(projectId);}
  }
  async discover():Promise<void>{await this.initialized;for(const row of await this.index.query<{id:string;project_id:string;database_path:string}>('SELECT id,project_id,database_path FROM service_locations WHERE kind=?',[this.kind])){this.locations.set(row.id,row.project_id);this.paths.set(row.project_id,row.database_path);}}
  private decode(row:Row):DurableRecord<T>{const value={value:JSON.parse(row.record_json) as T,version:row.version,generation:row.generation,owner:row.owner,leaseUntil:row.lease_until,stopRequested:!!row.stop_requested,operationId:row.operation_id,requestHash:row.request_hash};const previous=this.metadata.get(row.id);if(!previous||previous.owner!==this.owner||previous.generation!==row.generation||previous.owner!==row.owner)this.metadata.set(row.id,value);this.locations.set(row.id,row.project_id);return value;}
  private async remember(id:string,projectId:string){await this.initialized;this.locations.set(id,projectId);await this.index.transaction([{sql:'INSERT INTO service_locations(kind,id,project_id,database_path) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET project_id=excluded.project_id,database_path=excluded.database_path',params:[this.kind,id,projectId,this.paths.get(projectId)!]}]);}
  async create(value:T,operationId:string,hash:string,status:string,options:{exclusiveActive?:boolean;connectionId?:string}={}):Promise<DurableRecord<T>>{
    const db=await this.database(value.projectId);
    const previous=await db.query<Row>('SELECT * FROM service_records WHERE kind=? AND operation_id=?',[this.kind,operationId]);
    if(previous[0]){if(previous[0].request_hash!==hash)throw failure('OPERATION_ID_REUSE','操作 ID 已用于不同请求');await this.remember(previous[0].id,value.projectId);return this.decode(previous[0]);}
    const sessionId=this.kind==='workflow'&&status==='running'?(value as T&{request?:{sessionId?:string}}).request?.sessionId:undefined;
    try{await db.transaction([...(sessionId?[this.occupy(sessionId,value.id)]:[]),{sql:`INSERT INTO service_records(kind,id,project_id,operation_id,request_hash,record_json,status,connection_id) SELECT ?,?,?,?,?,?,?,?${options.exclusiveActive?" WHERE NOT EXISTS (SELECT 1 FROM service_records WHERE kind=? AND project_id=? AND status=? AND json_extract(record_json,'$.request.sessionId')=?)":'' }`,params:[this.kind,value.id,value.projectId,operationId,hash,JSON.stringify(value),status,options.connectionId??null,...(options.exclusiveActive?[this.kind,value.projectId,'running',(value as T&{request?:{sessionId?:string}}).request?.sessionId??'']:[])],expectChanges:1}]);}
    catch(error){const winner=(await db.query<Row>('SELECT * FROM service_records WHERE kind=? AND operation_id=?',[this.kind,operationId]))[0];if(winner){if(winner.request_hash!==hash)throw failure('OPERATION_ID_REUSE','操作 ID 已用于不同请求');await this.remember(winner.id,value.projectId);return this.decode(winner);}if(sessionId&&await this.sessionBusy(db,sessionId,value.id))throw failure('SESSION_BUSY','此会话已有活动任务，请等待或选择另一会话');if(options.exclusiveActive&&(error as {code?:string}).code==='DB_CONFLICT')throw failure('WORKFLOW_BUSY','此工程已有协作制作任务');throw error;}
    await this.remember(value.id,value.projectId);return (await this.read(value.id,value.projectId))!;
  }
  async read(id:string,projectId?:string):Promise<DurableRecord<T>|undefined>{await this.discover();const project=projectId??this.locations.get(id);if(!project)return;const row=(await (await this.database(project)).query<Row>('SELECT * FROM service_records WHERE kind=? AND id=?',[this.kind,id]))[0];if(row){await this.remember(id,project);return this.decode(row);}}
  async findOperation(projectId:string,operationId:string):Promise<DurableRecord<T>|undefined>{const row=(await(await this.database(projectId)).query<Row>('SELECT * FROM service_records WHERE kind=? AND operation_id=?',[this.kind,operationId]))[0];if(row){await this.remember(row.id,projectId);return this.decode(row);}}
  async list(projectId?:string):Promise<DurableRecord<T>[]>{await this.discover();if(projectId)await this.database(projectId);const out:DurableRecord<T>[]=[];for(const id of projectId?[projectId]:this.paths.keys()){for(const row of await(await this.database(id)).query<Row>('SELECT * FROM service_records WHERE kind=?',[this.kind])){await this.remember(row.id,id);out.push(this.decode(row));}}return out;}
  async claim(id:string,projectId:string,options:{connectionId?:string;connectionLimit?:number;maxConcurrent?:number}={}):Promise<DurableRecord<T>|undefined>{
    const db=await this.database(projectId),now=Date.now();
    const limits=options.connectionId?' AND (SELECT COUNT(*) FROM service_records WHERE kind=? AND connection_id=? AND owner IS NOT NULL AND lease_until>?)<?':'';
    const total=options.maxConcurrent?' AND (SELECT COUNT(*) FROM service_records WHERE kind=? AND owner IS NOT NULL AND lease_until>?)<?':'';
    try{await db.transaction([{sql:`UPDATE service_records SET owner=?,lease_until=?,generation=generation+1 WHERE kind=? AND id=? AND (owner IS NULL OR lease_until<=?) AND stop_requested=0${limits}${total}`,params:[this.owner,now+30000,this.kind,id,now,...(options.connectionId?[this.kind,options.connectionId,now,options.connectionLimit??2]:[]),...(options.maxConcurrent?[this.kind,now,options.maxConcurrent]:[])],expectChanges:1}]);}catch(error){if((error as {code?:string}).code==='DB_CONFLICT')return;throw error;}return this.read(id,projectId);
  }
  private occupy(sessionId:string,id:string){return {sql:"INSERT INTO session_activity(session_id,kind,task_id) VALUES(?,'workflow',?) ON CONFLICT(session_id) DO UPDATE SET task_id=excluded.task_id WHERE session_activity.kind='workflow' AND session_activity.task_id=excluded.task_id",params:[sessionId,id],expectChanges:1};}
  private async sessionBusy(db:AgentDatabase,sessionId:string,id:string){const row=(await db.query<{kind:string;task_id:string}>('SELECT kind,task_id FROM session_activity WHERE session_id=?',[sessionId]))[0];return !!row&&(row.kind!=='workflow'||row.task_id!==id);}
  async save(value:T,status:string):Promise<void>{
    const record=this.metadata.get(value.id);if(!record)throw failure('RECORD_NOT_LOADED','任务记录尚未读取');
    const owned=record.owner===this.owner,sessionId=this.kind==='workflow'&&status==='running'?(value as T&{request?:{sessionId?:string}}).request?.sessionId:undefined;const sessionGuard=sessionId?" AND NOT EXISTS (SELECT 1 FROM service_records AS other WHERE other.kind='workflow' AND other.project_id=? AND other.id<>? AND other.status='running' AND json_extract(other.record_json,'$.request.sessionId')=?)":'';
    try{await(await this.database(value.projectId)).transaction([...(sessionId?[this.occupy(sessionId,value.id)]:[]),{sql:`UPDATE service_records SET record_json=?,status=?,version=version+1 WHERE kind=? AND id=? AND version=?${owned?' AND owner=? AND generation=? AND lease_until>?':' AND (owner IS NULL OR lease_until<=?)'}${sessionGuard}`,params:[JSON.stringify(value),status,this.kind,value.id,record.version,...(owned?[this.owner,record.generation,Date.now()]:[Date.now()]),...(sessionId?[value.projectId,value.id,sessionId]:[])],expectChanges:1},...(this.kind==='workflow'&&status!=='running'?[{sql:"DELETE FROM session_activity WHERE kind='workflow' AND task_id=?",params:[value.id]}]:[])]);}
    catch(error){if(sessionId&&await this.sessionBusy(await this.database(value.projectId),sessionId,value.id))throw failure('SESSION_BUSY','此会话已有活动任务，请等待或选择另一会话');if((error as {code?:string}).code==='DB_CONFLICT')throw failure('TASK_LEASE_LOST','任务已由另一执行者推进，拒绝旧结果');throw error;}
    record.version++;record.value=value;const current=this.metadata.get(value.id);if(!current||current.generation===record.generation&&current.version<=record.version)this.metadata.set(value.id,record);
  }
  async renew(id:string,projectId:string,generation:number):Promise<boolean>{
    const db=await this.database(projectId);try{await db.transaction([{sql:'UPDATE service_records SET lease_until=? WHERE kind=? AND id=? AND owner=? AND generation=? AND lease_until>?',params:[Date.now()+30000,this.kind,id,this.owner,generation,Date.now()],expectChanges:1}]);}catch(error){if((error as {code?:string}).code==='DB_CONFLICT')throw failure('TASK_LEASE_LOST','任务执行租约已失效');throw error;}
    const row=(await db.query<{stop_requested:number}>('SELECT stop_requested FROM service_records WHERE kind=? AND id=?',[this.kind,id]))[0];return !!row?.stop_requested;
  }
  async assertLease(id:string,projectId:string,generation:number,allowStopped=false):Promise<void>{const row=(await(await this.database(projectId)).query<{owner:string;generation:number;lease_until:number;stop_requested:number}>('SELECT owner,generation,lease_until,stop_requested FROM service_records WHERE kind=? AND id=?',[this.kind,id]))[0];if(!row||row.owner!==this.owner||row.generation!==generation||row.lease_until<=Date.now())throw failure('TASK_LEASE_LOST','任务执行租约已失效');if(row.stop_requested&&!allowStopped)throw failure('TASK_PAUSED','任务已请求暂停');}
  async stop(id:string,projectId:string,generation?:number):Promise<void>{try{await(await this.database(projectId)).transaction([{sql:'UPDATE service_records SET stop_requested=1 WHERE kind=? AND id=?'+(generation===undefined?'':' AND generation=?'),params:[this.kind,id,...(generation===undefined?[]:[generation])],expectChanges:1}]);}catch(error){if((error as {code?:string}).code==='DB_CONFLICT')throw failure('TASK_LEASE_LOST','停止请求的执行代次已过期');throw error;}}
  async resume(id:string,projectId:string):Promise<void>{await(await this.database(projectId)).transaction([{sql:'UPDATE service_records SET stop_requested=0 WHERE kind=? AND id=? AND (owner IS NULL OR lease_until<=?)',params:[this.kind,id,Date.now()],expectChanges:1}]);}
  async release(id:string,projectId:string,generation:number):Promise<void>{await(await this.database(projectId)).transaction([{sql:'UPDATE service_records SET owner=NULL,lease_until=0 WHERE kind=? AND id=? AND owner=? AND generation=?',params:[this.kind,id,this.owner,generation]}]);const value=this.metadata.get(id);if(value?.owner===this.owner&&value.generation===generation){value.owner=null;value.leaseUntil=0;}}
  async close():Promise<void>{await this.initialized;await Promise.allSettled([...this.opening.values()]);await Promise.all([...this.databases.values(),this.index].map(db=>db.close()));}
}
