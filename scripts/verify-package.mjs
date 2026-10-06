import { _electron as electron } from 'playwright-core';
import { cp, mkdtemp, mkdir, readFile, writeFile, readlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('.'),temp=await mkdtemp(join(tmpdir(),'yingliu-package-'));
const source=join(root,'artifacts/映流 Studio Demo.app'),app=join(temp,'映流 Studio Demo.app');
await cp(source,app,{recursive:true,verbatimSymlinks:true});
async function links(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isSymbolicLink())assert.ok(!isAbsolute(await readlink(file)),'app symlink must be relative');else if(entry.isDirectory())await links(file);}}
await links(app);
const env={...process.env,YINGLIU_DATA_DIR:join(temp,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
const native=await electron.launch({executablePath:join(app,'Contents/MacOS/Electron'),args:[],cwd:temp,env,timeout:45000});
const checks=[];const pass=name=>{checks.push({name,status:'PASS'});console.log('PASS '+name);};
try{
  const page=await native.firstWindow();await page.waitForSelector('[data-testid="provider-mode"]');pass('relocated app starts outside source workspace');
  const call=async(endpoint,payload={})=>{const response=await page.evaluate(async({endpoint,payload})=>window.yingliu.call(endpoint,payload),{endpoint,payload});if(!response.ok)throw new Error(response.error.message);return response.value;};
  await page.getByRole('button',{name:'空白工程',exact:true}).click();await page.getByRole('button',{name:'镜头',exact:true}).waitFor();let snapshot=await call('current');assert.equal(snapshot.project.shots.length,0);pass('blank storyboard graph');
  for(let i=0;i<3;i++){await page.getByRole('button',{name:'镜头',exact:true}).click();await page.waitForTimeout(650);}snapshot=await call('current');assert.equal(snapshot.project.shots.length,3);const before=[...snapshot.project.shotOrder];pass('manual graph adds three connected shots');
  const chips=page.locator('.vs-shotchip');await chips.nth(2).dragTo(chips.nth(0));await page.waitForTimeout(850);snapshot=await call('current');assert.equal(snapshot.project.shotOrder[0],before[2]);pass('manual storyboard drag updates graph order');
  await page.getByRole('button',{name:'全图概览',exact:true}).click();await page.getByRole('button',{name:'预览',exact:true}).click();
  let start=Date.now();while((snapshot=await call('current')).task?.status==='running'){if(Date.now()-start>120000)throw new Error('manual graph preview timeout');await new Promise(r=>setTimeout(r,300));}assert.equal(snapshot.task.status,'complete',snapshot.task.message);pass('manual storyboard renders without conversation');
  const preview=page.frameLocator('iframe[title="影片画面预览"]');await preview.locator('canvas').waitFor();await page.getByRole('button',{name:'播放',exact:true}).waitFor({state:'visible'});assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isEnabled(),true);pass('preview iframe ready handshake');
  await page.locator('.vs-shotchip').first().click();await page.getByRole('tab',{name:'前端源码'}).click();await page.getByRole('textbox',{name:'HTML 源码'}).waitFor();const editor=page.getByRole('textbox',{name:'HTML 源码'});await editor.fill((await editor.inputValue())+'\n<!-- packaged edit -->');await page.getByRole('button',{name:'保存源码',exact:true}).click();
  start=Date.now();while((snapshot=await call('current')).task?.status==='running'){if(Date.now()-start>120000)throw new Error('source check timeout');await new Promise(r=>setTimeout(r,300));}assert.equal(snapshot.task.status,'complete',snapshot.task.message);assert.ok(!(await page.locator('[role="alert"]').allTextContents()).some(t=>/revision|版本|失败/.test(t)));pass('UI source edit commits with CAS and real runtime check');
  await page.getByRole('tab',{name:'影片预览'}).click();await page.getByRole('button',{name:'全图概览',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await mkdir(join(root,'artifacts/acceptance'),{recursive:true});await page.screenshot({path:join(root,'artifacts/acceptance/07-packaged.png')});
  await writeFile(join(root,'artifacts/acceptance/package-verification.json'),JSON.stringify({checks,platform:process.platform,arch:process.arch,checkedAt:new Date().toISOString(),relocatedBundle:app,dataDirectory:env.YINGLIU_DATA_DIR,distribution:'local ad-hoc signature; not notarized'},null,2)+'\n');
}finally{await native.close();}
