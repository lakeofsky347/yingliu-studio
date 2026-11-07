import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

interface ProjectPathFileSystem {
  realpath(file:string):Promise<string>;
  lstat(file:string):Promise<{isDirectory():boolean;isSymbolicLink():boolean}>;
}
export interface ProjectOpenPathOptions {
  /** Trusted host/test overrides; these are never accepted from application RPC. */
  platform?:NodeJS.Platform;
  fileSystem?:ProjectPathFileSystem;
}
function outside(message='请选择本项目文件'):Error&{code:string} {
  return Object.assign(new Error(message),{code:'PATH_OUTSIDE_PROJECT'});
}
function within(root:string,target:string,paths:typeof path.posix):boolean {
  const relative=paths.relative(root,target);
  return relative===''||(!paths.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+paths.sep));
}

/** Validate the logical and physical boundaries before handing a path to Electron. */
export async function projectOpenPath(root:string,target=root,options:ProjectOpenPathOptions={}):Promise<string> {
  const paths=(options.platform??process.platform)==='win32'?path.win32:path.posix;
  const fs=options.fileSystem??{realpath,lstat};
  const absoluteRoot=paths.resolve(root),absoluteTarget=paths.resolve(target);
  if(!within(absoluteRoot,absoluteTarget,paths))throw outside();
  const info=await fs.lstat(absoluteRoot);
  if(!info.isDirectory()||info.isSymbolicLink())throw outside('项目目录须为真实目录');
  const physicalRoot=await fs.realpath(absoluteRoot),physicalTarget=await fs.realpath(absoluteTarget);
  if(!within(physicalRoot,physicalTarget,paths))throw outside('请选择本项目文件；链接指向项目外部');
  // Hand off the verified destination instead of a replaceable project-local link.
  return physicalTarget;
}
