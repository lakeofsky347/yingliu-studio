import type { ProviderHost, SecretStore } from '../app/contracts.ts';

/** Trusted application services. Scene pages never receive this interface. */
export interface HostContext {
  llm:ProviderHost;
  credentials:SecretStore;
  reveal?:(path:string)=>Promise<void>;
}
