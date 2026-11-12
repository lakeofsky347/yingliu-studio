import {AgentDatabase} from '../agent/database.ts';
import type {CommitOperation} from './store.ts';
export interface ExternalOperationIntent {id:string;payloadHash:string;kind:string;status:'pending';createdAt:string}
const schema='CREATE TABLE IF NOT EXISTS host_external_intents (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)';
/** A durable pre-submission claim. An unresolved supplier request is never silently repeated. */
export async function reserveExternalOperation(filename:string,operation:CommitOperation,kind:string):Promise<void>{
 const database=new AgentDatabase(filename);
 try{
  await database.transaction([{sql:schema}]);
  try{await database.transaction([{sql:'INSERT OR IGNORE INTO host_external_intents(id,payload_hash,kind,created_at) VALUES(?,?,?,?)',params:[operation.id,operation.payloadHash,kind,new Date().toISOString()],expectChanges:1}]);}
  catch(error){
   if((error as {code?:string}).code!=='DB_CONFLICT')throw error;
   const [prior]=await database.query<{payload_hash:string;kind:string}>('SELECT payload_hash,kind FROM host_external_intents WHERE id=?',[operation.id]);
   if(!prior||prior.payload_hash!==operation.payloadHash||prior.kind!==kind)throw Object.assign(new Error('operationId 已用于不同的供应商请求'),{code:'OPERATION_CONFLICT'});
   throw Object.assign(new Error('此操作已有未决执行意图；请通过 operation.get / operation.intent 对账原请求，禁止自动重新生成'),{code:'OPERATION_UNRESOLVED'});
  }
 }finally{await database.close();}
}
export async function readExternalOperation(filename:string,id:string):Promise<ExternalOperationIntent|undefined>{
 const database=new AgentDatabase(filename);
 try{await database.transaction([{sql:schema}]);const [row]=await database.query<{id:string;payload_hash:string;kind:string;created_at:string}>('SELECT * FROM host_external_intents WHERE id=?',[id]);return row?{id:row.id,payloadHash:row.payload_hash,kind:row.kind,status:'pending',createdAt:row.created_at}:undefined;}
 finally{await database.close();}
}
