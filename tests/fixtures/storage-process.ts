import {ProjectStore,type CommitOperation} from '../../src/host/store.ts';
import {dirname} from 'node:path';

const [root,title,operationJson]=process.argv.slice(2);
if(!root||!title)throw new Error('Missing storage process fixture arguments');
const operation=operationJson?JSON.parse(operationJson) as CommitOperation:undefined;
const store=new ProjectStore({baseDirectory:dirname(root),async onCommitPhase(phase){
  if(phase!=='staged')return;
  const release=new Promise<void>(resolve=>process.once('message',()=>resolve()));
  process.send?.({ready:true});await release;
}});
try{
  const project=await store.readProject(root),expectedRevision=project.revision;
  project.revision++;project.title=title;
  const saved=await store.commit(root,project,{}, {expectedRevision,operation});
  process.send?.({result:{ok:true,revision:saved.revision,title:saved.title}});
}catch(error){process.send?.({result:{ok:false,code:(error as {code?:string}).code,message:String(error)}});}
finally{process.disconnect?.();}
