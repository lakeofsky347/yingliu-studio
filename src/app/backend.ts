import { join, resolve } from 'node:path';
import type { BackendPort, ProviderHost, SecretStore } from './contracts.ts';
import type { RpcResult, StudioSnapshot } from '../shared/types.ts';
import { ProjectHub } from '../host/project-hub.ts';

export interface AppBackendOptions {
  dataDirectory:string;
  providers:ProviderHost;
  credentials:SecretStore;
  reveal?:(path:string)=>Promise<void>;
}

/** Native shell and conversation coordinator share this application backend. */
export class AppBackend implements BackendPort {
  private readonly hub:ProjectHub;
  constructor(options:AppBackendOptions){
    this.hub=new ProjectHub({llm:options.providers,credentials:options.credentials,reveal:options.reveal},
      {baseDirectory:join(resolve(options.dataDirectory),'projects')});
  }
  call<T=StudioSnapshot>(endpoint:string,payload:unknown={}):Promise<T>{return this.hub.call<T>(endpoint,payload);}
  route(endpoint:string,payload:unknown={}):Promise<RpcResult>{return this.hub.route(endpoint,payload);}
  dispose():Promise<void>{return this.hub.dispose();}
}
