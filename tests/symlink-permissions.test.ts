import assert from 'node:assert/strict';
import test from 'node:test';
import type { symlink } from 'node:fs/promises';
import { createFileSymlinkOrSkip } from './fixtures/symlink.ts';

test('Windows file symlink permission prerequisites are explicitly recorded as skipped assertions',async()=>{
  for(const code of ['EPERM','EACCES']){
    const reasons:string[]=[];const create:typeof symlink=async()=>{throw Object.assign(new Error('synthetic permission prerequisite'),{code});};
    assert.equal(await createFileSymlinkOrSkip({skip:reason=>{reasons.push(reason??'');}},'/fixture/target','/fixture/link',{platform:'win32',create}),false);
    assert.equal(reasons.length,1);assert.match(reasons[0]!,new RegExp(code));assert.match(reasons[0]!,/安全断言未执行/);
  }
});

test('other Windows errors and every non-Windows symlink error fail the test',async()=>{
  for(const [platform,code]of [['win32','ENOENT'],['win32','EIO'],['linux','EPERM'],['linux','EACCES'],['darwin','EPERM']] as const){
    let skipped=false;const failure=Object.assign(new Error('synthetic unexpected error'),{code});
    await assert.rejects(createFileSymlinkOrSkip({skip:()=>{skipped=true;}},'/fixture/target','/fixture/link',{platform,create:async()=>{throw failure;}}),error=>error===failure);assert.equal(skipped,false);
  }
});
