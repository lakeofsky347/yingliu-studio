import {parentPort,workerData} from 'node:worker_threads';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

if(workerData.filename!==':memory:')mkdirSync(dirname(workerData.filename),{recursive:true});
let database=new DatabaseSync(workerData.filename,{timeout:5000,enableForeignKeyConstraints:true,allowExtension:false,enableDoubleQuotedStringLiterals:false});
// DELETE also supports concurrent processes and works with the SQLite shipped in Node 22.18.
database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
function execute(input){
  if(!input||typeof input.sql!=='string'||!Array.isArray(input.params??[]))throw new Error('Invalid database statement');
  if(/^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH)\b/i.test(input.sql))throw new Error('Transaction control belongs to AgentDatabase.transaction');
  const params=input.params??[];
  if(params.some(value=>value!==null&&typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value))&&typeof value!=='bigint'&&!ArrayBuffer.isView(value)))throw new Error('Invalid SQL parameter');
  const statement=database.prepare(input.sql);
  let result;
  if(statement.columns().length){const rows=statement.all(...params);result={rows,changes:Number(database.prepare('SELECT changes() AS count').get().count)};}
  else result={changes:Number(statement.run(...params).changes)};
  if(input.expectChanges!==undefined&&result.changes!==input.expectChanges)throw Object.assign(new Error('Database compare-and-set conflict'),{code:'DB_CONFLICT'});
  return result;
}
parentPort.on('message',({id,kind,payload})=>{
  try{
    let value;
    if(kind==='close'){const current=database;database=undefined;try{current?.close();}catch(error){parentPort.postMessage({id,error:{message:error instanceof Error?error.message:String(error),code:'DATABASE_ERROR'}});parentPort.close();return;}parentPort.postMessage({id,value:null});parentPort.close();return;}
    if(kind==='query')value=execute(payload).rows??[];
    else if(kind==='transaction'){
      if(!Array.isArray(payload))throw new Error('Invalid transaction');
      database.exec('BEGIN IMMEDIATE');
      try{value=payload.map((statement,index)=>{try{return execute(statement);}catch(error){error.statementIndex=index;throw error;}});database.exec('COMMIT');}
      catch(error){if(database.isTransaction)database.exec('ROLLBACK');throw error;}
    }else throw new Error('Unknown database request');
    parentPort.postMessage({id,value});
  }catch(error){parentPort.postMessage({id,error:{message:error instanceof Error?error.message:String(error),code:error?.code==='DB_CONFLICT'?'DB_CONFLICT':error?.errcode===5||error?.errcode===6?'DB_BUSY':error?.code??'DATABASE_ERROR',errcode:error?.errcode,statementIndex:error?.statementIndex}});}
});
