import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretStore } from '../app/contracts.ts';
import { isCredentialError } from '../app/secrets.ts';
import type { SecretStoreStatus } from '../shared/types.ts';

/** Inject Electron's safeStorage so policy and persistence can be tested without a desktop. */
export interface NativeSafeStorage {
  isEncryptionAvailable():boolean;
  getSelectedStorageBackend?():string;
  encryptString(value:string):Buffer;
  decryptString(value:Buffer):string;
}
const LINUX_SECURE_BACKENDS=new Set(['gnome_libsecret','kwallet','kwallet5','kwallet6']);
function failure(code:string,message:string){return Object.assign(new Error(message),{code});}
export class NativeSecrets implements SecretStore {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private directory:string,private storage:NativeSafeStorage,private platform:NodeJS.Platform=process.platform){}
  private capability():SecretStoreStatus {
    let backend=this.platform==='darwin'?'macos_keychain':this.platform==='win32'?'windows_dpapi':'unknown';
    try{
      if(this.platform==='linux')backend=this.storage.getSelectedStorageBackend?.()??'unknown';
      if(!this.storage.isEncryptionAvailable())return {available:false,backend,error:'系统安全存储不可用。请启用并解锁系统钥匙环后重试；已有密钥会保留，也可清除。'};
      if(this.platform==='linux'&&!LINUX_SECURE_BACKENDS.has(backend))return {available:false,backend,error:'Linux 未连接可保护密钥的系统钥匙环。请启用并解锁 Secret Service 或 KWallet 后重试；已有密钥会保留，也可清除。'};
      if(!['darwin','win32','linux'].includes(this.platform))return {available:false,backend,error:'当前系统尚未提供受支持的安全存储。已有密钥会保留，也可清除。'};
      return {available:true,backend};
    }catch{return {available:false,backend,error:'无法检查系统安全存储。请解锁系统钥匙环后重试；已有密钥会保留，也可清除。'};}
  }
  private assertAvailable(){const capability=this.capability();if(!capability.available)throw failure('CREDENTIALS_UNAVAILABLE',capability.error!);}
  private get file(){return join(this.directory,'credentials.encrypted.json');}
  private async readState():Promise<{values:Record<string,string>;contents?:string}> {
    let contents:string;
    try{contents=await readFile(this.file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {values:Object.create(null) as Record<string,string>};throw failure('CREDENTIALS_READ_FAILED','应用凭据文件无法读取。请检查应用数据目录权限；已有密钥不会被覆盖。');}
    try{
      const value:unknown=JSON.parse(contents);
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
      const values:Record<string,string>=Object.create(null);
      for(const [ref,encrypted]of Object.entries(value)){
        if(typeof encrypted!=='string'||!encrypted||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted))throw new Error();
        values[ref]=encrypted;
      }
      return {values,contents};
    }catch{throw failure('CREDENTIALS_CORRUPT','应用凭据文件格式损坏。请保留该文件并从备份恢复；应用不会覆盖或删除其他密钥。');}
  }
  private async read(){return (await this.readState()).values;}
  private decrypt(encrypted:string):string {
    this.assertAvailable();
    try{return this.storage.decryptString(Buffer.from(encrypted,'base64'));}
    catch{throw failure('CREDENTIALS_DECRYPT_FAILED','已保存的密钥无法由当前系统钥匙环解密。请恢复原系统钥匙环，或清除该密钥后重新配置；工程仍可手动编辑。');}
  }
  async status(ref?:string):Promise<SecretStoreStatus> {
    await this.queue;const capability=this.capability();
    if(ref===undefined)return capability;
    try{
      const values=await this.read(),hasStoredKey=Object.hasOwn(values,ref);
      if(!capability.available||!hasStoredKey)return {...capability,hasStoredKey};
      this.decrypt(values[ref]!);return {...capability,hasStoredKey};
    }catch(error){
      if(!isCredentialError(error))throw error;
      return {...capability,available:false,...((error as {code:string}).code==='CREDENTIALS_DECRYPT_FAILED'?{hasStoredKey:true}:{}),error:(error as Error).message};
    }
  }
  async get(ref:string):Promise<string|undefined> {
    await this.queue;const values=await this.read();if(!Object.hasOwn(values,ref))return undefined;
    return this.decrypt(values[ref]!);
  }
  private async persistContents(contents:string) {
    await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=this.file+'.tmp-'+randomUUID();
    try{await writeFile(temporary,contents,{mode:0o600});await rename(temporary,this.file);}
    finally{await rm(temporary,{force:true});}
  }
  withUpdate(ref:string,value:string|undefined,commit:()=>Promise<void>):Promise<void> {
    const result=this.queue.then(async()=>{
      // Check before touching disk: weak backends must leave existing ciphertext unchanged.
      if(value!==undefined)this.assertAvailable();
      const previous=await this.readState(),values={...previous.values};
      if(value===undefined)delete values[ref];
      else try{values[ref]=this.storage.encryptString(value).toString('base64');}catch{throw failure('CREDENTIALS_ENCRYPT_FAILED','系统安全存储未能保存密钥。请解锁系统钥匙环后重试；原密钥已保留。');}
      await this.persistContents(JSON.stringify(values)+'\n');
      try{await commit();}catch(error){
        try{if(previous.contents===undefined)await rm(this.file,{force:true});else await this.persistContents(previous.contents);}catch{throw failure('CREDENTIALS_ROLLBACK_FAILED','设置保存失败，原密钥恢复也未成功。请检查应用数据目录权限并重新检查模型设置。');}
        throw error;
      }
    });this.queue=result.catch(()=>{});return result;
  }
  async set(ref:string,value:string){await this.withUpdate(ref,value,async()=>{});}
  async delete(ref:string){await this.withUpdate(ref,undefined,async()=>{});}
}
