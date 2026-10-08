import assert from 'node:assert/strict';
import test from 'node:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSecrets, type NativeSafeStorage } from '../src/desktop/native-secrets.ts';
import { ProviderManager } from '../src/app/model.ts';
import { createApplication } from '../src/app/application.ts';
import type { ProviderSettings } from '../src/app/contracts.ts';
import type { StudioSnapshot } from '../src/shared/types.ts';
import { SpeechSynthesizer } from '../src/host/audio.ts';

// Synthetic AES fixture tests policy and persistence, not an actual OS keychain.
function storageFixture(backend='gnome_libsecret',available=true) {
  const state={backend,available,encryptions:0,decryptions:0,failEncrypt:false,failDecrypt:false};
  const key=Buffer.alloc(32,7);
  const storage:NativeSafeStorage={
    isEncryptionAvailable:()=>state.available,getSelectedStorageBackend:()=>state.backend,
    encryptString(value){state.encryptions++;if(state.failEncrypt)throw new Error('synthetic sensitive encryption details');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},
    decryptString(value){state.decryptions++;if(state.failDecrypt)throw new Error('synthetic sensitive decryption details');const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8');},
  };
  return {state,storage};
}
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'yingliu-native-secrets-'));return {directory,file:join(directory,'credentials.encrypted.json'),close:()=>rm(directory,{recursive:true,force:true})};}
const MODEL_REF='yingliu.custom-model.api-key',TTS_REF='YINGLIU_TTS_API_KEY';

for(const [platform,backend]of [['darwin','unused'],['win32','unused'],['linux','gnome_libsecret'],['linux','kwallet'],['linux','kwallet5'],['linux','kwallet6']] as const){
  test(`native credentials persist, replace and delete with ${platform}/${backend} policy`,async()=>{
    const f=await fixture(),{storage}=storageFixture(backend);const store=new NativeSecrets(f.directory,storage,platform);
    try{
      assert.equal((await store.status()).available,true);assert.equal(await store.get(MODEL_REF),undefined);
      await Promise.all([store.set(MODEL_REF,'synthetic-model-key'),store.set(TTS_REF,'synthetic-tts-key')]);
      assert.equal(await store.get(MODEL_REF),'synthetic-model-key');assert.ok(!(await readFile(f.file,'utf8')).includes('synthetic-model-key'));
      if(process.platform!=='win32')assert.equal((await stat(f.file)).mode&0o777,0o600);
      const restarted=new NativeSecrets(f.directory,storage,platform);assert.equal(await restarted.get(TTS_REF),'synthetic-tts-key');
      await restarted.set(MODEL_REF,'replacement-key');assert.equal(await restarted.get(MODEL_REF),'replacement-key');
      await restarted.delete(MODEL_REF);assert.equal(await new NativeSecrets(f.directory,storage,platform).get(MODEL_REF),undefined);assert.equal(await store.get(TTS_REF),'synthetic-tts-key');
    }finally{await f.close();}
  });
}

for(const [backend,available]of [['basic_text',true],['unknown',true],['future_unrecognized_backend',true],['gnome_libsecret',false]] as const){
  test(`Linux ${backend}, available=${available} refuses weak writes/reads but permits targeted removal`,async()=>{
    const f=await fixture(),secure=storageFixture();const initial=new NativeSecrets(f.directory,secure.storage,'linux');
    try{
      await initial.set(MODEL_REF,'synthetic-model-key');await initial.set(TTS_REF,'synthetic-tts-key');const original=await readFile(f.file,'utf8');
      const weak=storageFixture(backend,available),store=new NativeSecrets(f.directory,weak.storage,'linux');
      assert.equal((await store.status(MODEL_REF)).available,false);assert.equal((await store.status(MODEL_REF)).hasStoredKey,true);
      await assert.rejects(store.set(MODEL_REF,'replacement-key'),/钥匙环|安全存储/);assert.equal(await readFile(f.file,'utf8'),original);
      await assert.rejects(store.get(MODEL_REF),/钥匙环|安全存储/);assert.equal(weak.state.encryptions,0);assert.equal(weak.state.decryptions,0);
      await store.delete(MODEL_REF);assert.equal(await store.get(MODEL_REF),undefined);assert.equal((await store.status(TTS_REF)).hasStoredKey,true);
      assert.equal(await initial.get(TTS_REF),'synthetic-tts-key');
    }finally{await f.close();}
  });
}

test('missing Linux backend capability and unavailable macOS/Windows refuse encryption',async()=>{
  const f=await fixture();
  try{
    const missing=storageFixture();delete missing.storage.getSelectedStorageBackend;
    const linux=new NativeSecrets(f.directory,missing.storage,'linux');assert.equal((await linux.status()).backend,'unknown');await assert.rejects(linux.set(MODEL_REF,'fixture'),/钥匙环/);
    for(const platform of ['darwin','win32'] as const){const unavailable=storageFixture('unused',false),store=new NativeSecrets(f.directory,unavailable.storage,platform);await assert.rejects(store.set(MODEL_REF,'fixture'),/安全存储/);await store.delete(MODEL_REF);assert.equal(unavailable.state.encryptions,0);}
  }finally{await f.close();}
});

test('decrypt/encrypt failures preserve other keys and expose only recovery instructions',async()=>{
  const f=await fixture(),{storage,state}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');
  try{
    await store.set(MODEL_REF,'synthetic-model-key');await store.set(TTS_REF,'synthetic-tts-key');const original=await readFile(f.file,'utf8');
    state.failEncrypt=true;await assert.rejects(store.set(MODEL_REF,'replacement'),/原密钥已保留/);assert.equal(await readFile(f.file,'utf8'),original);state.failEncrypt=false;
    state.failDecrypt=true;const status=await store.status(MODEL_REF);assert.equal(status.available,false);assert.equal(status.hasStoredKey,true);assert.match(status.error!,/无法.*解密/);assert.ok(!status.error!.includes('sensitive'));
    await assert.rejects(store.get(MODEL_REF),/无法.*解密/);await store.delete(MODEL_REF);assert.equal((await store.status(MODEL_REF)).hasStoredKey,false);state.failDecrypt=false;assert.equal(await store.get(TTS_REF),'synthetic-tts-key');
  }finally{await f.close();}
});

test('credential transaction rolls back exact ciphertext without an available keychain',async()=>{
  const f=await fixture(),secure=storageFixture();
  try{
    const initial=new NativeSecrets(f.directory,secure.storage,'linux');await initial.set(MODEL_REF,'synthetic-model-key');await initial.set(TTS_REF,'synthetic-tts-key');
    const formatted=JSON.stringify(JSON.parse(await readFile(f.file,'utf8')),null,3);await writeFile(f.file,formatted);const weak=storageFixture('basic_text'),store=new NativeSecrets(f.directory,weak.storage,'linux');
    await assert.rejects(store.withUpdate(MODEL_REF,undefined,async()=>{assert.equal(Object.hasOwn(JSON.parse(await readFile(f.file,'utf8')),MODEL_REF),false);throw new Error('synthetic configuration failure');}),/configuration failure/);
    assert.equal(await readFile(f.file,'utf8'),formatted);assert.equal(weak.state.decryptions,0);await store.delete(MODEL_REF);assert.equal(await initial.get(TTS_REF),'synthetic-tts-key');
    const emptyDirectory=join(f.directory,'empty'),empty=new NativeSecrets(emptyDirectory,secure.storage,'linux');await assert.rejects(empty.withUpdate(MODEL_REF,'new-key',async()=>{throw new Error('synthetic commit failure');}),/commit failure/);await assert.rejects(readFile(join(emptyDirectory,'credentials.encrypted.json')),/ENOENT/);
  }finally{await f.close();}
});

test('corrupt credential files stay intact and cannot discard unrelated references',async()=>{
  const f=await fixture(),{storage}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');
  try{
    for(const corrupt of ['[]','{"model":true}','{"model":"invalid!!"}','{incomplete']){
      await writeFile(f.file,corrupt);assert.equal((await store.status(MODEL_REF)).available,false);assert.match((await store.status(MODEL_REF)).error!,/格式损坏/);
      await assert.rejects(store.delete(MODEL_REF),/格式损坏/);await assert.rejects(store.set(MODEL_REF,'fixture'),/格式损坏/);assert.equal(await readFile(f.file,'utf8'),corrupt);
    }
  }finally{await f.close();}
});

test('provider settings preserve inaccessible keys, allow configuration edits and clear with rollback',async()=>{
  const f=await fixture(),{storage,state}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');let fetches=0;
  try{
    const manager=new ProviderManager(f.directory,store,{fetch:async()=>{fetches++;throw new Error('must not call a provider');}});await manager.save({name:'before',apiKey:'synthetic-model-key'});await store.set(TTS_REF,'synthetic-tts-key');
    const original=await readFile(f.file,'utf8');state.backend='basic_text';let settings=await manager.settings();assert.equal(settings.hasKey,false);assert.equal(settings.credentialStatus?.hasStoredKey,true);
    settings=await manager.save({name:'editable without unlocking'});assert.equal(settings.config.name,'editable without unlocking');assert.equal(await readFile(f.file,'utf8'),original);
    assert.equal((await manager.check()).ok,false);await assert.rejects(manager.complete([{role:'user',content:'x'}],'system',new AbortController().signal),/钥匙环/);assert.equal(fetches,0);
    await rm(join(f.directory,'provider.json'));await mkdir(join(f.directory,'provider.json'));
    await assert.rejects(manager.save({name:'must roll back',apiKey:''}));assert.equal(await readFile(f.file,'utf8'),original);assert.equal((await manager.settings()).config.name,'editable without unlocking');
    await rm(join(f.directory,'provider.json'),{recursive:true});settings=await manager.save({apiKey:''});assert.equal(settings.credentialStatus?.hasStoredKey,false);state.backend='gnome_libsecret';assert.equal(await store.get(TTS_REF),'synthetic-tts-key');
  }finally{await f.close();}
});

for(const mode of ['weak-backend','decrypt-failure'] as const){
  test(`application restart and manual editing work with retained keys and ${mode}`,async()=>{
    const f=await fixture(),{storage,state}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');let application:Awaited<ReturnType<typeof createApplication>>|undefined;
    try{
      await store.set(MODEL_REF,'synthetic-model-key');await store.set(TTS_REF,'synthetic-tts-key');
      application=await createApplication({dataDirectory:f.directory,credentials:store});const project=await application.backend.call('create',{blank:true,title:'手工工程'});await application.dispose();application=undefined;
      if(mode==='weak-backend')state.backend='basic_text';else state.failDecrypt=true;
      const original=await readFile(f.file,'utf8');application=await createApplication({dataDirectory:f.directory,credentials:new NativeSecrets(f.directory,storage,'linux')});
      const current=await application.backend.call('current',{projectId:project.project!.id});assert.equal(current.project!.title,'手工工程');assert.equal(current.ttsConfigured,false);assert.equal(current.credentialStatus?.hasStoredKey,true);assert.equal(current.credentialStatus?.available,false);
      const result=await application.route('providers.get');assert.equal(result.ok,true);if(result.ok){const settings=result.value as ProviderSettings;assert.equal(settings.hasKey,false);assert.equal(settings.credentialStatus?.hasStoredKey,true);}
      const manual=await application.backend.call('apply',{projectId:current.project!.id,expectedRevision:current.project!.revision,title:'仍可保存'});assert.equal(manual.project!.title,'仍可保存');assert.equal(await readFile(f.file,'utf8'),original);
      const chat=await application.route('chat.send',{projectId:project.project!.id,provider:'custom',model:'deepseek-chat',message:'不会发送到模型',intent:'discuss'});assert.equal(chat.ok,false);if(!chat.ok)assert.match(chat.error.message,/钥匙环/);
      await application.backend.call<StudioSnapshot>('tts',{apiKey:''});assert.equal((await store.status(TTS_REF)).hasStoredKey,false);assert.equal((await store.status(MODEL_REF)).hasStoredKey,true);
      const cleared=await application.route('providers.save',{apiKey:''});assert.equal(cleared.ok,true);assert.equal((await store.status(MODEL_REF)).hasStoredKey,false);
    }finally{await application?.dispose();await f.close();}
  });
}

test('TTS key removal bypasses invalid migrated service settings and failed configuration rolls back ciphertext',async()=>{
  const f=await fixture(),{storage,state}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');let application:Awaited<ReturnType<typeof createApplication>>|undefined;
  try{
    await store.set(TTS_REF,'synthetic-tts-key');await store.set(MODEL_REF,'synthetic-model-key');
    await mkdir(join(f.directory,'projects'),{recursive:true});
    await writeFile(join(f.directory,'projects','tts.json'),JSON.stringify({endpoint:'',model:'',voice:'',speed:1,enabled:true}));
    state.backend='basic_text';application=await createApplication({dataDirectory:f.directory,credentials:store});const original=await readFile(f.file,'utf8');
    await assert.rejects(application.backend.call('tts',{enabled:true,endpoint:'https://speech.example.test/v1',model:'',voice:'',apiKey:''}),/模型和声音/);assert.equal(await readFile(f.file,'utf8'),original);
    await rm(join(f.directory,'projects','tts.json'));await mkdir(join(f.directory,'projects','tts.json'));
    await assert.rejects(application.backend.call('tts',{apiKey:''}));assert.equal(await readFile(f.file,'utf8'),original);
    await rm(join(f.directory,'projects','tts.json'),{recursive:true});const cleared=await application.backend.call('tts',{apiKey:''});assert.equal(cleared.credentialStatus?.hasStoredKey,false);assert.equal((await store.status(MODEL_REF)).hasStoredKey,true);
  }finally{await application?.dispose();await f.close();}
});

test('local speech ignores an inaccessible unrelated API key while remote speech still requires unlocking it',async()=>{
  const f=await fixture(),{storage,state}=storageFixture(),store=new NativeSecrets(f.directory,storage,'linux');let application:Awaited<ReturnType<typeof createApplication>>|undefined;
  const originalSynthesize=SpeechSynthesizer.prototype.synthesize;let synthesizerCalls=0;
  SpeechSynthesizer.prototype.synthesize=async(_root,_input,settings)=>{synthesizerCalls++;assert.equal(settings.endpoint,'local:say');assert.equal(settings.apiKey,undefined);throw new Error('synthetic local speech adapter reached');};
  try{
    await store.set(TTS_REF,'synthetic-tts-key');const original=await readFile(f.file,'utf8');state.backend='basic_text';await mkdir(join(f.directory,'projects'),{recursive:true});
    const speechFile=join(f.directory,'projects','tts.json');await writeFile(speechFile,JSON.stringify({endpoint:'local:say',model:'',voice:'',speed:1,enabled:true}));
    application=await createApplication({dataDirectory:f.directory,credentials:store});const project=await application.backend.call('create',{title:'本机语音与密钥隔离'}),id=project.project!.id,shotId=project.project!.shots[0]!.id;
    async function finishSpeech(){
      let snapshot=await application!.backend.call('audio',{projectId:id,operation:'synthesize',shotId,text:'合成测试，不执行真实本机语音'});const started=Date.now();
      while(snapshot.task?.status==='running'){assert.ok(Date.now()-started<5000,'synthetic speech task timed out');await new Promise(resolve=>setTimeout(resolve,10));snapshot=await application!.backend.call('current',{projectId:id});}
      return snapshot;
    }
    const local=await finishSpeech();assert.equal(synthesizerCalls,1);assert.match(local.task!.error!,/synthetic local speech adapter reached/);
    await writeFile(speechFile,JSON.stringify({endpoint:'https://speech.example.test/v1',model:'tts-fixture',voice:'fixture',speed:1,enabled:true}));
    const remote=await finishSpeech();assert.equal(synthesizerCalls,1);assert.match(remote.task!.error!,/钥匙环/);assert.equal(await readFile(f.file,'utf8'),original);assert.equal((await store.status(TTS_REF)).hasStoredKey,true);
  }finally{SpeechSynthesizer.prototype.synthesize=originalSynthesize;await application?.dispose();await f.close();}
});
