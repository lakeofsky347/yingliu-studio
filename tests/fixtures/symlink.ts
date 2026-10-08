import { symlink } from 'node:fs/promises';
import type { TestContext } from 'node:test';

/** A permission failure is an unmet Windows test prerequisite, not a passed security assertion. */
export async function createFileSymlinkOrSkip(context:Pick<TestContext,'skip'>,target:string,path:string,options:{platform?:NodeJS.Platform;create?:typeof symlink}={}):Promise<boolean> {
  try{await (options.create??symlink)(target,path,'file');return true;}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if((options.platform??process.platform)==='win32'&&(code==='EPERM'||code==='EACCES')){
      context.skip(`Windows 文件符号链接创建权限不足（${code}）。需管理员权限或允许当前进程创建文件符号链接的开发者模式；符号链接安全断言未执行。`);return false;
    }
    throw error;
  }
}
