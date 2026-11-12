import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentDatabase} from '../src/agent/database.ts';

test('SQLite worker uses durable pragmas and rolls back the entire transaction on a CAS failure',async()=>{
  const database=new AgentDatabase(':memory:');
  try{
    assert.equal((await database.query<{synchronous:number}>('PRAGMA synchronous'))[0]?.synchronous,2);
    assert.equal((await database.query<{foreign_keys:number}>('PRAGMA foreign_keys'))[0]?.foreign_keys,1);
    assert.equal((await database.query<{timeout:number}>('PRAGMA busy_timeout'))[0]?.timeout,5000);
    await database.transaction([{sql:'CREATE TABLE records(id TEXT PRIMARY KEY, value BLOB, version INTEGER)'}]);
    const rows=await database.transaction([{sql:'INSERT INTO records VALUES(?,?,?)',params:['one',Buffer.from([1,2,255]),0],expectChanges:1},{sql:'SELECT * FROM records'}]);
    assert.equal(rows[0]?.changes,1);assert.deepEqual(Buffer.from((rows[1]?.rows?.[0] as {value:Uint8Array}).value),Buffer.from([1,2,255]));
    await assert.rejects(database.transaction([
      {sql:'UPDATE records SET version=version+1 WHERE id=?',params:['one'],expectChanges:1},
      {sql:'UPDATE records SET version=version+1 WHERE id=?',params:['missing'],expectChanges:1},
    ]),error=>(error as {code?:string;statementIndex?:number}).code==='DB_CONFLICT'&&(error as {statementIndex:number}).statementIndex===1);
    assert.equal((await database.query<{version:number}>('SELECT version FROM records'))[0]?.version,0);
  }finally{await database.close();}
  await assert.rejects(database.query('SELECT 1'),error=>(error as {code?:string}).code==='DATABASE_CLOSED');
});

test('independent worker connections coordinate writes to one file without a process ownership lock',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-database-')),filename=join(directory,'state.sqlite');
  const first=new AgentDatabase(filename),second=new AgentDatabase(filename);
  try{
    await first.transaction([{sql:'CREATE TABLE counter(id INTEGER PRIMARY KEY,value INTEGER)'},{sql:'INSERT INTO counter VALUES(1,0)'}]);
    assert.equal((await second.query<{journal_mode:string}>('PRAGMA journal_mode'))[0]?.journal_mode,'delete');
    await Promise.all(Array.from({length:20},(_,index)=>(index%2?first:second).transaction([{sql:'UPDATE counter SET value=value+1 WHERE id=1',expectChanges:1}])));
    assert.equal((await first.query<{value:number}>('SELECT value FROM counter'))[0]?.value,20);
  }finally{await Promise.all([first.close(),second.close()]);await rm(directory,{recursive:true,force:true});}
});

test('synchronous SQLite evaluation stays off the calling event loop',async()=>{
  const database=new AgentDatabase(':memory:');
  try{
    await database.query('SELECT 1');let timerRan=false;
    const pending=database.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT sum(x) AS total FROM n');
    const timer=new Promise<void>(resolve=>setTimeout(()=>{timerRan=true;resolve();},0));
    await pending;assert.equal(timerRan,true);await timer;
  }finally{await database.close();}
});
