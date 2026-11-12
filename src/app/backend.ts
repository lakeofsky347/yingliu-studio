import { join, resolve } from 'node:path';
import type { BackendPort, ProviderHost, SecretStore } from './contracts.ts';
import type { RpcResult, StudioSnapshot } from '../shared/types.ts';
import { ProjectHub } from '../host/project-hub.ts';
import type { GeneratedFile, MediaTask } from '../jobs/contracts.ts';
import type { TtsSettings } from '../shared/types.ts';

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
  mediaPort(){return this.hub.mediaPort();}
  stageWorkflowMedia(id:string,task:MediaTask,files:GeneratedFile[],signal:AbortSignal){return this.hub.stageWorkflowMedia(id,task,files,signal);}
  workflowVoice(id:string,shotId:string,text:string,signal:AbortSignal,settings?:TtsSettings){return this.hub.workflowVoice(id,shotId,text,signal,settings);}
  workflowCapture(id:string,frame:number,signal:AbortSignal,candidate?:import('../workflows/contracts.ts').WorkflowCandidate){return this.hub.workflowCapture(id,frame,signal,candidate);}
  operationIntent(projectId:string,operationId:string){return this.hub.call<import('../host/operation-intents.ts').ExternalOperationIntent|undefined>('operation.intent',{projectId,operationId});}
  operationReceipt(projectId:string,operationId:string){return this.hub.call<import('../host/store.ts').OperationReceipt|undefined>('operation.get',{projectId,operationId});}
  validateCandidate(id:string|undefined,candidate:import('../host/candidate.ts').CandidateInput,signal?:AbortSignal){return this.hub.validateCandidate(id,candidate,signal);}
  dispose():Promise<void>{return this.hub.dispose();}
}
