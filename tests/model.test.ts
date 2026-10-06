import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/core/index.ts';
import { DEMO_MODEL, demoSceneSource, demoStoryboard, ProviderManager } from '../src/app/model.ts';
import type { SecretStore } from '../src/app/contracts.ts';

class MemorySecrets implements SecretStore {values=new Map<string,string>();async get(ref:string){return this.values.get(ref);}async set(ref:string,value:string){this.values.set(ref,value);}async delete(ref:string){this.values.delete(ref);}}

test('provider defaults are offline; custom DeepSeek configuration persists without keys',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-'));const secrets=new MemorySecrets();
  try{const providers=new ProviderManager(directory,secrets);await providers.initialize();let settings=await providers.settings();assert.equal(settings.mode,'demo');assert.equal(settings.config.baseUrl,'https://api.deepseek.com/v1');assert.equal(settings.config.model,'deepseek-chat');assert.equal(settings.hasKey,false);
    assert.deepEqual(providers.host().listProviders().map(p=>p.id),['demo','custom']);assert.equal((await providers.host().listModels('demo'))[0]?.id,DEMO_MODEL);
    settings=await providers.save({apiKey:'fixture-secret-do-not-persist',mode:'custom',name:'我的接口'});assert.equal(settings.hasKey,true);const config=await readFile(join(directory,'provider.json'),'utf8');assert.ok(!config.includes('fixture-secret'));
    const reopened=new ProviderManager(directory,secrets);assert.equal((await reopened.settings()).config.name,'我的接口');assert.equal((await reopened.settings()).mode,'custom');
    await reopened.save({apiKey:''});assert.equal((await reopened.settings()).hasKey,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('offline storyboard varies by topic and returns real editable scene modules',()=>{
  const a=createProject('海边','海边散步'),b=createProject('猫','猫的午后');a.targetDuration=18;b.targetDuration=18;
  const shotsA=demoStoryboard(a),shotsB=demoStoryboard(b);assert.equal(shotsA.length,3);assert.equal(shotsA.reduce((sum,s)=>sum+s.durationFrames,0),540);
  assert.notEqual(shotsA[0]?.params.text,shotsB[0]?.params.text);assert.ok(shotsA[1]?.params.text.includes('海边散步'));
  for(let i=0;i<3;i++){const scene=demoSceneSource(i);assert.match(scene.js,/export function render\(ctx\)/);assert.match(scene.js,/ctx\.progress/);assert.match(scene.js,/params:p/);assert.ok(scene.html.length>100);}
});

test('compatible SSE consumes all text, retains full multi-turn messages and normal completion',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-stream-'));const originalFetch=globalThis.fetch;const captured:unknown[]=[];
  try{const providers=new ProviderManager(directory,new MemorySecrets());await providers.save({mode:'custom',apiKey:'fixture-only',baseUrl:'https://provider.example/v1',model:'fixture-chat'});
    globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://provider.example/v1/chat/completions');captured.push(JSON.parse(String(options?.body)));return new Response('data: {"choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
    const result=await providers.complete([{role:'user',content:'first'},{role:'assistant',content:'prior'},{role:'user',content:'second'}],'system',new AbortController().signal);
    assert.equal(result,'{"ok":true}');assert.equal((captured[0] as {messages:unknown[]}).messages.length,4);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('provider rejects truncated responses and never fetches without an app key',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-truncated-'));const originalFetch=globalThis.fetch;let calls=0;
  try{const providers=new ProviderManager(directory,new MemorySecrets());globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'unfinished'},finish_reason:'length'}]});};
    await assert.rejects(providers.complete([{role:'user',content:'x'}],'system',new AbortController().signal),/API Key/);assert.equal(calls,0);
    await providers.save({apiKey:'fixture-only'});await assert.rejects(providers.complete([{role:'user',content:'x'}],'system',new AbortController().signal),/不完整/);assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
