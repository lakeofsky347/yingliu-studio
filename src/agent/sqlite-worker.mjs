import {parentPort,workerData} from 'node:worker_threads';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const filename=workerData?.filename??process.argv[2];
if(!filename)throw new Error('SQLite worker requires a database filename');
if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
let database=new DatabaseSync(filename,{timeout:5000,enableForeignKeyConstraints:true,allowExtension:false,enableDoubleQuotedStringLiterals:false});
// DELETE also supports concurrent processes and works with the SQLite shipped in Node 22.18.
database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const post=message=>{if(parentPort)parentPort.postMessage(message);else process.send?.(message);};
const shutdown=()=>{if(parentPort)setImmediate(()=>parentPort.close());else process.exit(0);};
function execute(input){
  if(!database)throw new Error('Database has been closed');
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
function handle({id,kind,payload}){
  try{
    let value;
    if(kind==='close'){
      const current=database;database=undefined;
      if(parentPort){try{current?.close();}catch(error){post({id,error:{message:error instanceof Error?error.message:String(error),code:'DATABASE_ERROR'}});shutdown();return;}post({id,value:null});shutdown();return;}
      // A child process must exit even if SQLite close stalls; the OS then drops the Windows file lock.
      post({id,value:null});process.exit(0);
    }
    if(!database)throw Object.assign(new Error('Database has been closed'),{code:'DATABASE_CLOSED'});
    if(kind==='query')value=execute(payload).rows??[];
    else if(kind==='transaction'){
      if(!Array.isArray(payload))throw new Error('Invalid transaction');
      database.exec('BEGIN IMMEDIATE');
      try{value=payload.map((statement,index)=>{try{return execute(statement);}catch(error){error.statementIndex=index;throw error;}});database.exec('COMMIT');}
      catch(error){if(database?.isTransaction)database.exec('ROLLBACK');throw error;}
    }else throw new Error('Unknown database request');
    post({id,value});
  }catch(error){post({id,error:{message:error instanceof Error?error.message:String(error),code:error?.code==='DB_CONFLICT'?'DB_CONFLICT':error?.errcode===5||error?.errcode===6?'DB_BUSY':error?.code??'DATABASE_ERROR',errcode:error?.errcode,statementIndex:error?.statementIndex}});}
}
if(parentPort)parentPort.on('message',handle);
else process.on('message',handle);
