import {ProjectStore,type CreateInput,type CommitOperation} from '../../src/host/store.ts';

const [baseDirectory,inputJson,operationJson]=process.argv.slice(2);
if(!baseDirectory||!inputJson||!operationJson)throw new Error('Missing create fixture arguments');
const store=new ProjectStore({baseDirectory,async onCommitPhase(phase){
  if(phase!=='staged')return;
  const release=new Promise<void>(resolve=>process.once('message',()=>resolve()));process.send?.({ready:true});await release;
}});
try{const created=await store.create(JSON.parse(inputJson) as CreateInput,JSON.parse(operationJson) as CommitOperation);process.send?.({result:{ok:true,revision:created.project.revision,title:created.project.title}});}
catch(error){process.send?.({result:{ok:false,code:(error as {code?:string}).code,message:String(error)}});}
finally{process.disconnect?.();}
