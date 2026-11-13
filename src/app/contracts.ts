import type { ProviderGroup, RpcResult, StudioSnapshot, SecretStoreStatus } from '../shared/types.ts';
import type { AgentCandidatePayload, AgentLease, AgentTaskStatus, ValidationReceipt } from '../agent/contracts.ts';
import type { SceneSource, VideoProject } from '../shared/types.ts';

export interface BackendPort {
  call<T=StudioSnapshot>(endpoint:string, payload?:unknown):Promise<T>;
  route(endpoint:string, payload?:unknown):Promise<RpcResult>;
}
export interface SecretStore {
  get(ref:string):Promise<string|undefined>;
  set(ref:string, value:string):Promise<void>;
  delete(ref:string):Promise<void>;
  status?(ref?:string):Promise<SecretStoreStatus>;
  /** Preserve encrypted bytes on configuration failure, including when a key cannot be decrypted. */
  withUpdate?(ref:string,value:string|undefined,commit:()=>Promise<void>):Promise<void>;
}
export interface ProviderConfig {
  id:string; name:string; baseUrl:string; model:string; supportsVision:boolean;
  temperature?:number; maxTokens?:number; requestTimeoutMs?:number;
  contextMessageLimit?:number; contextCharLimit?:number; enableVision?:boolean;
  maxVisionImages?:number; maxVisionBytes?:number; maxVisionDimension?:number;
}
export interface ProviderSettings {
  config:ProviderConfig; hasKey:boolean; mode:'demo'|'custom'; credentialStatus?:SecretStoreStatus;
  ready?:boolean; route?:{provider:string;model:string}; sceneRoute?:{provider:string;model:string}; legacyConfig?:ProviderConfig; legacyHasKey?:boolean; legacyCredentialStatus?:SecretStoreStatus;
}
export interface ChatMessage {
  id:string; role:'user'|'assistant'; content:string; createdAt:string;
  turnId?:string; status?:'pending'|'succeeded'|'failed'|'cancelled'|'interrupted';
  actions?:{label:string;projectId?:string;shotId?:string;frame?:number;revision?:number}[];
}
export interface Conversation {
  id:string; projectId?:string; messages:ChatMessage[]; provider:string; model:string;
  sessionId?:string; schemaVersion?:2;
  turns?:ConversationTurn[];
}
export interface ConversationTurn {
  id:string; request:ChatInput; status:'pending'|'succeeded'|'failed'|'cancelled'|'interrupted';
  createdAt:string; updatedAt:string; error?:string; retryOf?:string;
  committedRevision?:number; imageAssetIds?:string[];
  operationId?:string; requestHash?:string; taskId?:string; phase?:AgentTaskStatus; validation?:ValidationReceipt;
  modelCalls?:number; toolCalls?:number; legacy?:boolean; toolReceipts?:Record<string,unknown>[];
}
export interface ChatInput {
  sessionId:string; operationId:string; expectedRevision:number|null;
  message:string; projectId?:string; shotId?:string; provider:string; model:string; role?:'director'|'scene'|'vision';
  intent?:'auto'|'chat'|'discuss'|'create'|'modify'; retryTurnId?:string; packId?:string;
  allowImageUpload?:boolean; imageAssetIds?:string[];
}
export interface ConversationExecution {
  lease?:AgentLease; taskId?:string; requestHash?:string;
  load?():Promise<Conversation|undefined>;
  save?(conversation:Conversation):Promise<void>;
  phase?(status:AgentTaskStatus,patch?:Record<string,unknown>):Promise<void>;
  reserve?(amount:{modelCalls?:number;toolCalls?:number}):Promise<void>;
  mutation?(operationId:string,payload:Record<string,unknown>):Promise<Record<string,unknown>>;
  assertComplete?():Promise<void>;
  restoreAccepted?(signal:AbortSignal):Promise<{candidates:AgentCandidatePayload[];snapshot?:StudioSnapshot}>;
  reconcile?():Promise<{projectId?:string;committedRevision?:number}>;
  validate?(input:{projectId?:string;expectedRevision:number|null;candidate:{project:VideoProject;sources:Record<string,SceneSource>};signal:AbortSignal}):Promise<ValidationReceipt>;
  externalTool?(tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;
  projectCreated?(projectId:string,conversation:Conversation):Promise<void>;
}
export interface ConversationServiceOptions { sessionId?:string; execution?:ConversationExecution }
export interface ProviderHost {
  listProviders():{id:string;name:string}[];
  listModels(id:string):Promise<ProviderGroup['models']>;
  resolveModelInfo?(id:string,model:string,signal?:AbortSignal):Promise<{inputModalities?:string[]}>;
  stream(options:{provider:string;model:string;messages:unknown[];system:string;maxTokens:number;sessionId:string;signal:AbortSignal}):AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message:string}}}>;
}
