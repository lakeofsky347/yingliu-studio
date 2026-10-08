import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { EnvironmentInfo, SecretStoreStatus } from '../shared/types.ts';
async function inspectTool(path:string,args:string[]){
  if(!path)return {available:false,version:'',message:'尚未找到，请在运行环境中选择可执行文件'};
  try{await access(path,constants.X_OK);}catch{return {available:false,version:'',message:'路径不存在或没有执行权限'};}
  return new Promise<{available:boolean;version:string;message:string}>(accept=>{
    const child=spawn(path,args,{stdio:['ignore','pipe','pipe']});let output='',settled=false;
    const finish=(available:boolean,message:string)=>{if(settled)return;settled=true;clearTimeout(timer);accept({available,version:output.split('\n').find(Boolean)?.slice(0,240)??'',message});};
    child.stdout.on('data',chunk=>{if(output.length<5000)output+=String(chunk);});child.stderr.on('data',chunk=>{if(output.length<5000)output+=String(chunk);});
    child.once('error',()=>finish(false,'无法执行该工具'));child.once('close',code=>finish(code===0,code===0?'已就绪':'执行版本检查失败'));
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(false,'工具检查超时');},5000);timer.unref();
  });
}
export async function applicationHealth(environment:EnvironmentInfo,model:{hasKey:boolean;config:{model:string};credentialStatus?:SecretStoreStatus},dataDirectory:string){
  const [browser,ffmpeg,ffprobe]=await Promise.all([inspectTool(environment.browserPath,['--version']),inspectTool(environment.ffmpegPath,['-version']),inspectTool(environment.ffprobePath,['-version'])]);
  return {dataDirectory,model:{configured:model.hasKey,model:model.config.model,credentialStatus:model.credentialStatus},tools:{browser:{path:environment.browserPath,...browser},ffmpeg:{path:environment.ffmpegPath,...ffmpeg},ffprobe:{path:environment.ffprobePath,...ffprobe}},canRender:browser.available&&ffmpeg.available&&ffprobe.available};
}
