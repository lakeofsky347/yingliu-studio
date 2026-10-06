import { resolve } from 'node:path';
import { AppBackend } from './backend.ts';
import { ProviderManager } from './model.ts';
import { ConversationService } from './conversation.ts';
import type { RpcResult } from '../shared/types.ts';
import type { ChatInput, SecretStore } from './contracts.ts';
import { foundationPacks } from './packs.ts';

export const ENDPOINTS=new Set(['catalog','current','create','open','save','import','source','saveSource','restoreSource','preview','generate','export','cancel','environment','reveal','apply','inspect','list','focus','audio','tts','packs.list','providers.get','providers.save','providers.check','chat.history','chat.send','chat.cancel']);
export class MemorySecrets implements SecretStore {
  private values=new Map<string,string>();
  async get(ref:string){return this.values.get(ref);}
  async set(ref:string,value:string){this.values.set(ref,value);}
  async delete(ref:string){this.values.delete(ref);}
}
export async function createApplication(options:{dataDirectory:string;credentials:SecretStore;reveal?:(path:string)=>Promise<void>}){
  const dataDirectory=resolve(options.dataDirectory);
  const providers=new ProviderManager(dataDirectory,options.credentials);await providers.initialize();
  const backend=new AppBackend({...options,dataDirectory,providers:providers.host()});
  const conversation=new ConversationService(backend,providers,dataDirectory);
  await backend.call('catalog');
  async function route(endpoint:string,payload:unknown={}):Promise<RpcResult>{
    try{
      if(!ENDPOINTS.has(endpoint))throw new Error('不支持此应用操作');
      const data=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
      let value:unknown;
      switch(endpoint){
        case 'packs.list':value=foundationPacks;break;
        case 'providers.get':value=await providers.settings();break;
        case 'providers.save':value=await providers.save(data);await backend.call('catalog');break;
        case 'providers.check':value=await providers.check();break;
        case 'chat.history':value=await conversation.history(typeof data.projectId==='string'?data.projectId:undefined);break;
        case 'chat.send':value=await conversation.send(data as unknown as ChatInput);break;
        case 'chat.cancel':value=await conversation.cancel();break;
        default:return backend.route(endpoint,payload);
      }
      return {ok:true,value};
    }catch(error){return {ok:false,error:{code:'APP_ERROR',message:error instanceof Error?error.message:'操作失败'}};}
  }
  return {backend,providers,conversation,route,async dispose(){await conversation.cancel();await backend.dispose();}};
}
export type Application=Awaited<ReturnType<typeof createApplication>>;
