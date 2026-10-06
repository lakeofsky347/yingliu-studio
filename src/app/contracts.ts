import type { ProviderGroup, RpcResult, StudioSnapshot } from '../shared/types.ts';

export interface BackendPort {
  call<T=StudioSnapshot>(endpoint:string, payload?:unknown):Promise<T>;
  route(endpoint:string, payload?:unknown):Promise<RpcResult>;
}
export interface SecretStore {
  get(ref:string):Promise<string|undefined>;
  set(ref:string, value:string):Promise<void>;
  delete(ref:string):Promise<void>;
}
export interface ProviderConfig {
  id:string; name:string; baseUrl:string; model:string; supportsVision:boolean;
}
export interface ProviderSettings {
  config:ProviderConfig; hasKey:boolean; mode:'demo'|'custom';
}
export interface ChatMessage {
  id:string; role:'user'|'assistant'; content:string; createdAt:string;
  actions?:{label:string;projectId?:string;shotId?:string;frame?:number;revision?:number}[];
}
export interface Conversation {
  id:string; projectId?:string; messages:ChatMessage[]; provider:string; model:string;
}
export interface ChatInput {
  message:string; projectId?:string; shotId?:string; provider:string; model:string;
}
export interface ProviderHost {
  listProviders():{id:string;name:string}[];
  listModels(id:string):Promise<ProviderGroup['models']>;
  resolveModelInfo?(id:string,model:string,signal?:AbortSignal):Promise<{inputModalities?:string[]}>;
  stream(options:{provider:string;model:string;messages:unknown[];system:string;maxTokens:number;sessionId:string;signal:AbortSignal}):AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message:string}}}>;
}
