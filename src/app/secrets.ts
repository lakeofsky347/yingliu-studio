import type { SecretStore } from './contracts.ts';
import type { SecretStoreStatus } from '../shared/types.ts';

export function isCredentialError(error:unknown):boolean {
  return typeof (error as {code?:unknown})?.code==='string'&&(error as {code:string}).code.startsWith('CREDENTIALS_');
}

/** Readiness must leave editing and key removal available when the OS cannot unlock a key. */
export async function inspectCredential(store:SecretStore,ref:string):Promise<{hasKey:boolean;credentialStatus?:SecretStoreStatus}> {
  const credentialStatus=await store.status?.(ref);
  if(credentialStatus&&!credentialStatus.available)return {hasKey:false,credentialStatus};
  try{return {hasKey:!!await store.get(ref),...(credentialStatus?{credentialStatus}:{})};}
  catch(error){
    if(!isCredentialError(error))throw error;
    return {hasKey:false,credentialStatus:{...credentialStatus,backend:credentialStatus?.backend??'unknown',available:false,error:(error as Error).message}};
  }
}

/** Native stores roll back ciphertext without decrypting an inaccessible previous key. */
export async function updateCredential(store:SecretStore,ref:string,value:string|undefined,commit:()=>Promise<void>):Promise<void> {
  if(store.withUpdate)return store.withUpdate(ref,value,commit);
  const previous=await store.get(ref);
  if(value===undefined)await store.delete(ref);else await store.set(ref,value);
  try{await commit();}catch(error){if(previous!==undefined)await store.set(ref,previous);else await store.delete(ref);throw error;}
}
