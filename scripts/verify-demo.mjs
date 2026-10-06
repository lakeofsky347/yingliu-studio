import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve('.'),out=join(root,'artifacts/acceptance'),data=join(root,'.local/acceptance-'+Date.now());await mkdir(out,{recursive:true});
const checks=[];const record=(name,details={})=>{checks.push({name,status:'PASS',...details});console.log('PASS '+name);};
const env={...process.env,YINGLIU_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let native,page;
async function launch(){native=await electron.launch({args:[root],env,timeout:45000});page=await native.firstWindow();await page.waitForSelector('[data-testid="provider-mode"]');}
async function call(endpoint,payload={}){const result=await page.evaluate(async({endpoint,payload})=>window.yingliu.call(endpoint,payload),{endpoint,payload});if(!result.ok)throw new Error(result.error.message);return result.value;}
async function settle(snapshot){const start=Date.now();while(snapshot.task?.status==='running'){if(Date.now()-start>240000)throw new Error('render timeout');await new Promise(r=>setTimeout(r,300));snapshot=await call('current',{projectId:snapshot.project.id});}assert.equal(snapshot.task?.status,'complete',snapshot.task?.message);return snapshot;}
try{
  await launch();record('native independent window');
  assert.deepEqual(await page.evaluate(()=>({node:typeof require,process:typeof process,bridge:typeof window.yingliu.call})),{node:'undefined',process:'undefined',bridge:'function'});record('editor sandbox and narrow preload');
  await page.screenshot({path:join(out,'01-welcome.png'),fullPage:true});
  await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.screenshot({path:join(out,'02-provider.png'),fullPage:true});await page.getByRole('button',{name:'关闭模型设置'}).click();
  await page.getByRole('textbox',{name:'创作指令'}).fill('做一个关于海边散步的短片');await page.getByRole('button',{name:'开始创作',exact:true}).click();
  await page.getByText('对话与工程已保存',{exact:true}).waitFor({timeout:120000});
  let snapshot=await call('current'),project=snapshot.project;assert.equal(project.shots.length,3);assert.equal(snapshot.previewRevision,project.revision);record('UI conversation creates three actual scenes',{projectId:project.id});
  const second=project.shotOrder[1];await page.locator('.vs-shotchip').nth(1).click();await page.getByRole('textbox',{name:'镜头标题',exact:true}).fill('用户手改：沿着海岸');await page.waitForTimeout(850);
  project=(await call('current')).project;assert.equal(project.shots.find(s=>s.id===second).title,'用户手改：沿着海岸');record('manual node property autosave');
  await page.getByRole('textbox',{name:'创作指令'}).fill('第二镜改为缩放，背景改成 #183c66');await page.getByRole('button',{name:'开始创作',exact:true}).click();await page.getByText('对话与工程已保存',{exact:true}).waitFor({timeout:120000});
  project=(await call('current')).project;assert.equal(project.shots.find(s=>s.id===second).title,'用户手改：沿着海岸');assert.equal(project.shots.find(s=>s.id===second).params.motion,'zoom');record('conversation preserves manual title and stable shot ID');
  const stale=await page.evaluate(async p=>window.yingliu.call('apply',{projectId:p.id,expectedRevision:p.revision-1,shotPatches:[]}),project);assert.equal(stale.ok,false);record('stale revision rejected');
  const inspected=await call('inspect',{projectId:project.id,frame:Math.floor(project.shots[0].durationFrames/2)});assert.ok(inspected.frame.sha256);await copyFile(inspected.frame.path,join(out,'03-scene-frame.png'));record('actual deterministic frame capture',{sha256:inspected.frame.sha256});
  const forbidden=await fetch(new URL('project.json',snapshot.previewUrl));assert.equal(forbidden.status,403);record('scene server blocks project state');
  const tokenless=await fetch(new URL('/api/current',page.url()),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(tokenless.status,403);record('editor HTTP requires CSRF token');
  const frame=page.frames().find(f=>f!==page.mainFrame()&&f.url().startsWith(new URL(snapshot.previewUrl).origin));if(frame){assert.deepEqual(await frame.evaluate(()=>({node:typeof require,bridge:typeof window.yingliu})),{node:'undefined',bridge:'undefined'});assert.equal(await frame.evaluate(()=>{try{void parent.yingliu;return false;}catch{return true;}}),true);assert.equal(await frame.evaluate(async()=>{try{await fetch('https://example.com/');return false;}catch{return true;}}),true);record('scene iframe has no desktop bridge or external fetch');}
  await page.screenshot({path:join(out,'04-storyboard.png'),fullPage:true});
  // Small genuine media export: six seconds, 144 PNG frames and a synthetic sound fixture.
  project=(await call('current')).project;project.target={width:640,height:360,fps:{num:24,den:1},audioMode:'mixed',quality:'small'};project.targetDuration=6;project.shots=project.shots.map(s=>({...s,durationFrames:48,params:{...s.params,fontSize:96}}));
  snapshot=await call('save',{project,expectedRevision:project.revision});project=snapshot.project;
  const ffmpeg=snapshot.environment.ffmpegPath,ffprobe=snapshot.environment.ffprobePath;
  const wav=join(data,'fixture-tone.wav');const tone=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1.5','-y',wav]);assert.equal(tone.status,0);
  snapshot=await call('import',{projectId:project.id,name:'验收用合成音，不是配音',mime:'audio/wav',dataBase64:(await readFile(wav)).toString('base64')});
  snapshot=await call('audio',{projectId:project.id,operation:'add',assetId:snapshot.project.assets.at(-1).id,role:'music',volume:0.08,loop:true});
  snapshot=await settle(await call('export',{projectId:project.id}));const output=snapshot.project.outputs.at(-1);assert.equal(output.frameCount,144);assert.equal(output.width,640);assert.equal(output.height,360);await copyFile(output.path,join(out,'yingliu-demo.mp4'));
  const probe=spawnSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',output.path],{encoding:'utf8'});assert.equal(probe.status,0);const media=JSON.parse(probe.stdout);assert.ok(media.streams.some(s=>s.codec_type==='audio'));assert.ok(media.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'));
  const decode=spawnSync(ffmpeg,['-v','error','-i',output.path,'-f','null','-'],{encoding:'utf8'});assert.equal(decode.status,0,decode.stderr);record('real MP4 encode probe and full decode',{frames:144,duration:Number(media.format.duration),audio:'synthetic test tone',qa:output.qa});
  await page.reload();await page.waitForSelector('.vs-shotchip');await page.getByRole('tab',{name:'影片预览'}).click();
  await page.getByRole('button',{name:'播放成片',exact:true}).click();await page.waitForSelector('video');const video=page.locator('video').first();await video.evaluate(async v=>{v.muted=true;await v.play();});await page.waitForTimeout(900);const playback=await video.evaluate(v=>({time:v.currentTime,error:v.error?.message??null,ready:v.readyState}));assert.ok(playback.time>0.1);assert.equal(playback.error,null);record('native exported video playback advances',playback);await page.screenshot({path:join(out,'05-export.png'),fullPage:true});
  // Disposable synthetic key verifies OS storage. No real provider request is performed.
  await call('providers.save',{mode:'demo',apiKey:'yingliu-fixture-secret-do-not-use'});const credentials=await readFile(join(data,'credentials.encrypted.json'),'utf8');assert.ok(!credentials.includes('yingliu-fixture-secret'));record('OS encrypted credential persistence');
  const oldId=project.id;await native.close();native=undefined;await launch();snapshot=await call('current');assert.equal(snapshot.project.id,oldId);assert.equal(snapshot.project.shots.find(s=>s.id===second).title,'用户手改：沿着海岸');const history=await call('chat.history',{projectId:oldId});assert.equal(history.messages.length,4);assert.equal((await call('providers.get')).hasKey,true);await call('providers.save',{apiKey:'',mode:'demo'});record('native restart restores project conversation and settings',{messages:history.messages.length});
  await page.setViewportSize({width:1180,height:800});await page.screenshot({path:join(out,'06-compact.png'),fullPage:true});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);assert.equal(overflow,false);record('compact desktop has no page overflow');
  await writeFile(join(out,'verification.json'),JSON.stringify({application:'映流 Studio',version:'0.1.0',checkedAt:new Date().toISOString(),checks,realProvider:'NOT_CHECKED',humanFullViewing:'NOT_CHECKED',platform:'macOS '+process.arch,dataDirectory:data,projectRoot:snapshot.root,environment:snapshot.environment},null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,report:join(out,'verification.json')}));
}finally{await native?.close();}
