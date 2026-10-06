import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../src/core/index.ts';
import { DEMO_MODEL, demoSceneSource, demoStoryboard, ProviderManager } from '../src/app/model.ts';
import type { SecretStore } from '../src/app/contracts.ts';

class MemorySecrets implements SecretStore {values=new Map<string,string>();async get(ref:string){return this.values.get(ref);}async set(ref:string,value:string){this.values.set(ref,value);}async delete(ref:string){this.values.delete(ref);}}

test('provider production defaults are custom and fixture never appears in normal catalog',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-'));const secrets=new MemorySecrets();
  try{const providers=new ProviderManager(directory,secrets);await providers.initialize();let settings=await providers.settings();assert.equal(settings.mode,'custom');assert.equal(settings.config.baseUrl,'https://api.deepseek.com/v1');assert.equal(settings.config.model,'deepseek-chat');assert.equal(settings.hasKey,false);
    assert.deepEqual(providers.host().listProviders().map(p=>p.id),['custom']);await assert.rejects(providers.host().listModels('demo'),/未知/);await assert.rejects(providers.save({mode:'demo'}),/仅供测试/);assert.equal((await new ProviderManager(join(directory,'fixture'),secrets,{allowFixtures:true}).host().listModels('demo'))[0]?.id,DEMO_MODEL);
    settings=await providers.save({apiKey:'fixture-secret-do-not-persist',mode:'custom',name:'我的接口'});assert.equal(settings.hasKey,true);const config=await readFile(join(directory,'provider.json'),'utf8');assert.ok(!config.includes('fixture-secret'));
    const reopened=new ProviderManager(directory,secrets);assert.equal((await reopened.settings()).config.name,'我的接口');assert.equal((await reopened.settings()).mode,'custom');
    await reopened.save({apiKey:''});assert.equal((await reopened.settings()).hasKey,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('model settings serialize concurrent partial saves and vision requires both explicit flags',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-settings-'));
  try{const providers=new ProviderManager(directory,new MemorySecrets());await Promise.all([providers.save({temperature:.3,name:'my custom'}),providers.save({maxTokens:1024,requestTimeoutMs:10000})]);const config=(await providers.settings()).config;assert.equal(config.name,'my custom');assert.equal(config.temperature,.3);assert.equal(config.maxTokens,1024);
    await providers.save({supportsVision:true});assert.deepEqual((await providers.host().listModels('custom'))[0]?.inputModalities,['text']);await providers.save({enableVision:true});assert.deepEqual((await providers.host().resolveModelInfo!('custom','deepseek-chat'))?.inputModalities,['text','image']);await assert.rejects(providers.save({maxTokens:1}),/maxTokens/);await assert.rejects(providers.save({supportsVision:false}),/确认/);
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

test('custom transport sends only enabled embedded images and enforces request text/image budgets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-model-vision-'));let calls=0;const captured:Record<string,any>[]=[];
  try{const providers=new ProviderManager(directory,new MemorySecrets(),{fetch:async(_url,options)=>{calls++;captured.push(JSON.parse(String(options?.body)));return Response.json({choices:[{message:{content:'完整回复'},finish_reason:'stop'}]});}});await providers.save({apiKey:'mock-key',supportsVision:true,contextCharLimit:8000,maxVisionBytes:1024});
    const image={type:'image_url' as const,image_url:{url:'data:image/png;base64,AA=='}};await assert.rejects(providers.complete([{role:'user',content:[image]}],'system',new AbortController().signal),/未启用/);assert.equal(calls,0);
    await providers.save({enableVision:true});await providers.complete([{role:'user',content:[{type:'text',text:'本轮授权图片'},image]}],'system',new AbortController().signal);assert.equal(captured[0]!.messages[1].content[1].image_url.url,image.image_url.url);
    await assert.rejects(providers.complete([{role:'user',content:'x'.repeat(8001)}],'system',new AbortController().signal),/文本上下文/);await assert.rejects(providers.complete([{role:'user',content:[image,image,image,image]}],'system',new AbortController().signal),/图片数量/);const oversized={type:'image_url' as const,image_url:{url:'data:image/png;base64,'+Buffer.alloc(1025).toString('base64')}};await assert.rejects(providers.complete([{role:'user',content:[oversized]}],'system',new AbortController().signal),/总字节/);assert.equal(calls,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
