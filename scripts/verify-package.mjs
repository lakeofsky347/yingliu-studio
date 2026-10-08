import { _electron as electron } from 'playwright-core';
import { cp, mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { assertHostTarget, assertRelativeSymlinks, electronRuntime, packageLayout, parsePackageOptions, probeElectron } from './package-layout.mjs';
const options=parsePackageOptions(process.argv.slice(2),true);
if(options.help){console.log('node scripts/verify-package.mjs [--layout-only] [--bundle PATH] [--platform darwin|win32|linux] [--arch x64|arm64]\n布局检查会执行包内 Electron Node 模式、依赖与工程备份恢复；不代表桌面 GUI 或渲染验收。');process.exit(0);}
const root=resolve('.'),temp=await mkdtemp(join(tmpdir(),'yingliu-package-'));
const layout=packageLayout(root,options.platform,options.arch);
const source=options.bundle?resolve(options.bundle):layout.destination,app=join(temp,layout.name);
const executable=join(app,layout.executableRelative),appRoot=join(app,layout.appRelative);
const env={...process.env,YINGLIU_DATA_DIR:join(temp,'user-data')};delete env.ELECTRON_RUN_AS_NODE;
let native,manifest,phase='relocation';
const checks=[];const pass=name=>{checks.push({name,status:'PASS'});console.log('PASS '+name);};
try{
  await cp(source,app,{recursive:true,verbatimSymlinks:true});
  await assertRelativeSymlinks(app);pass('bundle relocates with relative internal symlinks');
  phase='package layout';
  manifest=JSON.parse(await readFile(join(app,layout.manifestRelative),'utf8'));
  assert.equal(manifest.schemaVersion,1);assertHostTarget(manifest.platform,manifest.arch);
  for(const key of ['appRelative','executableRelative','launcherRelative'])assert.equal(manifest[key],layout[key]);
  const info=JSON.parse(await readFile(join(appRoot,'package.json'),'utf8'));
  assert.equal(info.main,'dist/desktop/main.cjs');assert.equal(info.version,manifest.version);
  assert.deepEqual((await readdir(appRoot)).sort(),['LICENSE','THIRD_PARTY_NOTICES.md','dist','licenses','node_modules','package.json']);
  assert.deepEqual((await readdir(join(appRoot,'node_modules'))).sort(),['fflate','playwright-core']);
  for(const file of ['dist/desktop/main.cjs','dist/desktop/preload.cjs','dist/web-server.mjs','dist/ui/index.html','dist/ui/app.js','dist/ui/app.css','LICENSE','THIRD_PARTY_NOTICES.md','licenses/LiteGraph-MIT.txt','licenses/React-MIT.txt','licenses/ReactDOM-MIT.txt','licenses/fflate-MIT.txt','node_modules/playwright-core/LICENSE','node_modules/playwright-core/NOTICE','node_modules/fflate/LICENSE'])assert.ok((await stat(join(appRoot,file))).isFile(),file);
  const runtimeResources=options.platform==='darwin'?'Contents/Resources':'';
  for(const file of ['LICENSE','LICENSES.chromium.html'])assert.ok((await stat(join(app,runtimeResources,file))).isFile(),file);
  assert.ok((await stat(executable)).isFile());assert.ok((await stat(join(app,layout.launcherRelative))).isFile());
  if(options.platform!=='win32')assert.ok((await stat(executable)).mode&0o111,'executable mode must survive copying');
  pass('platform launcher, app files, runtime dependencies and third-party licenses; workspace data excluded');
  phase='relocated runtime';
  const runtime=electronRuntime(executable);assertHostTarget(runtime.platform,runtime.arch);assert.equal(runtime.electron,manifest.electronVersion);
  pass('relocated Electron executes with actual host platform and architecture');
  const probe=join(temp,'dependencies.cjs');
  await writeFile(probe,`const assert=require('node:assert/strict');const {createRequire}=require('node:module');const {relative,isAbsolute}=require('node:path');const {realpathSync}=require('node:fs');const app=process.argv[2];const load=createRequire(app+'/package.json');for(const dependency of ['fflate','playwright-core']){const path=relative(realpathSync(app),realpathSync(load.resolve(dependency)));assert.ok(!path.startsWith('..')&&!isAbsolute(path),dependency+' must resolve inside relocated app');}const {zipSync,unzipSync}=load('fflate');const bytes=Buffer.from('independent archive codec');assert.deepEqual(Buffer.from(unzipSync(zipSync({'content.txt':bytes}))['content.txt']),bytes);assert.equal(typeof load('playwright-core').chromium.launch,'function');console.log('bundled dependencies loaded');`);
  assert.equal(probeElectron(executable,probe,[appRoot]),'bundled dependencies loaded');
  pass('ZIP codec and browser driver resolve exclusively from relocated app');
  if(options.platform==='linux'){
    phase='desktop entry installation';
    const desktopHome=join(temp,'desktop-menu');
    const desktop=await runChild(join(app,'install-desktop-entry.sh'),[],{...env,XDG_DATA_HOME:desktopHome},temp);
    assert.match(desktop,/已安装桌面入口/);const entry=await readFile(join(desktopHome,'applications/local.yingliu.studio.desktop'),'utf8');assert.match(entry,/Type=Application/);assert.ok(entry.includes(join(app,'yingliu-studio.sh')));
    pass('optional Linux desktop entry installs into isolated user menu');
  }
  phase='relocated application services';
  await verifyServices();pass('relocated application serves UI, creates project and backs up/restores using bundled modules');
  const skipReason=options.layoutOnly?'--layout-only requested':options.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY?'Linux display server unavailable':undefined;
  if(skipReason){checks.push({name:'desktop GUI and media rendering acceptance',status:'SKIP',reason:skipReason});console.log('SKIP desktop GUI: '+skipReason);}
  else{
  phase='desktop GUI';
  native=await electron.launch({executablePath:executable,args:[],cwd:temp,env,timeout:45000});
  await native.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  let page=await native.firstWindow();await page.getByRole('heading',{name:'我的影片',exact:false}).waitFor();pass('relocated app starts outside source workspace');
  const call=async(endpoint,payload={})=>{const response=await page.evaluate(async({endpoint,payload})=>window.yingliu.call(endpoint,payload),{endpoint,payload});if(!response.ok)throw new Error(response.error.message);return response.value;};
  await page.getByRole('button',{name:'新建影片',exact:true}).first().click();await page.getByRole('textbox',{name:'影片名称',exact:true}).fill('打包后手动制作');await page.getByRole('textbox',{name:'主题与创作简报',exact:true}).fill('独立目录中继续制作自己的影片');await page.getByRole('button',{name:'创建空白影片',exact:true}).click();await page.getByRole('button',{name:'镜头',exact:true}).waitFor();let snapshot=await call('current');assert.equal(snapshot.project.shots.length,0);pass('blank storyboard graph');
  const detectedBrowser=snapshot.environment.browserPath;await page.getByRole('tab',{name:'运行环境',exact:true}).click();await page.getByRole('textbox',{name:'Chromium 浏览器路径',exact:true}).fill(join(temp,'missing-browser'));await page.getByRole('button',{name:'保存并检查环境',exact:true}).click();await page.getByText('部分工具无法执行。工程可以继续编辑；请修正路径后重新检查。',{exact:true}).waitFor();assert.equal((await call('app.health')).canRender,false);pass('invalid executable reports actual readiness failure');await page.getByRole('textbox',{name:'Chromium 浏览器路径',exact:true}).fill(detectedBrowser);await page.getByRole('button',{name:'保存并检查环境',exact:true}).click();await page.getByText('本地浏览器、编码器和媒体检查工具已就绪。',{exact:true}).first().waitFor();assert.equal((await call('app.health')).canRender,true);pass('environment form executes and validates real tool versions');await page.getByRole('tab',{name:'影片预览',exact:true}).click();
  for(let i=0;i<3;i++){await page.getByRole('button',{name:'镜头',exact:true}).click();await page.waitForTimeout(650);}snapshot=await call('current');assert.equal(snapshot.project.shots.length,3);const before=[...snapshot.project.shotOrder];pass('manual graph adds three connected shots');
  const chips=page.locator('.vs-shotchip');await chips.nth(2).dragTo(chips.nth(0));await page.waitForTimeout(850);snapshot=await call('current');assert.equal(snapshot.project.shotOrder[0],before[2]);pass('manual storyboard drag updates graph order');
  await page.getByRole('button',{name:'全图概览',exact:true}).click();await page.getByRole('button',{name:'预览',exact:true}).click();
  let start=Date.now();while((snapshot=await call('current')).task?.status==='running'){if(Date.now()-start>120000)throw new Error('manual graph preview timeout');await new Promise(r=>setTimeout(r,300));}assert.equal(snapshot.task.status,'complete',snapshot.task.message);pass('manual storyboard renders without conversation');
  const preview=page.frameLocator('iframe[title="影片画面预览"]');await preview.locator('canvas').waitFor();await page.getByRole('button',{name:'播放',exact:true}).waitFor({state:'visible'});assert.equal(await page.getByRole('button',{name:'播放',exact:true}).isEnabled(),true);pass('preview iframe ready handshake');
  await page.locator('.vs-shotchip').first().click();await page.getByRole('tab',{name:'前端源码'}).click();await page.getByRole('textbox',{name:'HTML 源码'}).waitFor();const editor=page.getByRole('textbox',{name:'HTML 源码'});await editor.fill((await editor.inputValue())+'\n<!-- packaged edit -->');await page.getByRole('button',{name:'保存源码',exact:true}).click();
  start=Date.now();while((snapshot=await call('current')).task?.status==='running'){if(Date.now()-start>120000)throw new Error('source check timeout');await new Promise(r=>setTimeout(r,300));}assert.equal(snapshot.task.status,'complete',snapshot.task.message);assert.ok(!(await page.locator('[role="alert"]').allTextContents()).some(t=>/revision|版本|失败/.test(t)));pass('UI source edit commits with CAS and real runtime check');
  await editor.fill((await editor.inputValue())+'\n<!-- unsaved draft guard -->');await page.getByRole('button',{name:'项目首页',exact:true}).click();assert.equal(await page.locator('.vs-studio').count(),1);assert.ok((await editor.inputValue()).includes('unsaved draft guard'));assert.ok((await page.locator('.vs-project-status').textContent()).includes('源码未保存'));pass('unsaved source blocks project navigation and remains visible');await page.getByRole('button',{name:'保存源码',exact:true}).click();start=Date.now();while((snapshot=await call('current')).task?.status==='running'){if(Date.now()-start>120000)throw new Error('source guard check timeout');await new Promise(r=>setTimeout(r,300));}assert.equal(snapshot.task.status,'complete');
  await page.getByRole('tab',{name:'影片预览'}).click();await page.getByRole('button',{name:'全图概览',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(250);const graphBounds=await page.locator('.vs-graph-shell').boundingBox();assert.ok(graphBounds.height<440,'properties must not expand the graph');assert.ok(graphBounds.y+graphBounds.height/2<await page.evaluate(()=>window.innerHeight),'graph center is visible in desktop viewport');pass('wide desktop graph is bounded and visible');await mkdir(join(root,'artifacts/acceptance-v02'),{recursive:true});await page.screenshot({path:join(root,'artifacts/acceptance-v02/07-packaged.png')});await page.getByRole('spinbutton',{name:'跳转帧',exact:true}).fill('30');await page.getByRole('button',{name:'定位',exact:true}).click();await page.locator('iframe[title="影片画面预览"]').scrollIntoViewIfNeeded();await page.waitForTimeout(350);assert.equal(await page.getByTestId('current-frame').textContent(),'30');await page.screenshot({path:join(root,'artifacts/acceptance-v02/08-preview-visible.png')});pass('visible midframe preview and thumbnail composition');
  const archive=await call('app.exportProject',{projectId:snapshot.project.id});const restored=await call('app.importProject',{dataBase64:archive.dataBase64});assert.notEqual(restored.project.id,snapshot.project.id);pass('bundled ZIP codec backs up and restores outside source workspace');const id=snapshot.project.id,shotId=snapshot.project.shotOrder[0];await page.getByRole('textbox',{name:'镜头标题',exact:true}).fill('关闭前的修改已保存');await native.close();native=await electron.launch({executablePath:executable,args:[],cwd:temp,env,timeout:45000});page=await native.firstWindow();await page.getByRole('heading',{name:'我的影片',exact:false}).waitFor();const persisted=await call('current',{projectId:id});assert.equal(persisted.project.shots.find(shot=>shot.id===shotId).title,'关闭前的修改已保存');pass('closing drains immediate manual edits and restart preserves them');
  }
}catch(error){
  checks.push({name:phase,status:'FAIL',message:error instanceof Error?error.message:String(error)});console.error(error);process.exitCode=1;
}finally{
  if(native)await native.close().catch(error=>{checks.push({name:'desktop shutdown',status:'FAIL',message:String(error)});process.exitCode=1;});
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  await mkdir(join(root,'artifacts/acceptance-v02'),{recursive:true});
  const report={checks,platform:options.platform,arch:options.arch,checkedAt:new Date().toISOString(),sourceBundle:source,relocatedBundle:app,dataDirectory:env.YINGLIU_DATA_DIR,temporaryDirectoryRemoved:true,distribution:manifest?.distribution??'unknown',mode:options.layoutOnly?'layout-only':'automatic',guiVerified:checks.some(check=>check.name==='closing drains immediate manual edits and restart preserves them'&&check.status==='PASS'),status:checks.some(check=>check.status==='FAIL')?'FAIL':checks.some(check=>check.status==='SKIP')?'PARTIAL':'PASS'};
  await writeFile(join(root,'artifacts/acceptance-v02/package-verification.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(root,`artifacts/acceptance-v02/package-verification-${options.platform}-${options.arch}.json`),JSON.stringify(report,null,2)+'\n');
}

async function runChild(command,args,environment,cwd){
  const child=spawn(command,args,{env:environment,cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
  return new Promise((accept,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('packaged command timeout'));},20000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);if(code===0)accept(output);else reject(new Error(errors||'packaged command exited '+code));});
  });
}

async function verifyServices(){
  const child=spawn(executable,[join(appRoot,'dist/web-server.mjs')],{cwd:temp,env:{...env,ELECTRON_RUN_AS_NODE:'1',YINGLIU_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',errors='';
  child.stderr.on('data',chunk=>{errors+=chunk;});
  const stopped=new Promise(accept=>child.once('close',accept));
  try{
    const origin=await new Promise((accept,reject)=>{
      const timer=setTimeout(()=>reject(new Error('relocated application service startup timeout: '+errors)),20000);
      const fail=error=>{clearTimeout(timer);reject(error);};
      child.once('error',fail);child.once('exit',code=>fail(new Error('relocated service exited '+code+': '+errors)));
      child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});
    });
    const html=await (await fetch(origin,{signal:AbortSignal.timeout(15000)})).text();
    const token=html.match(/name="yingliu-token" content="([a-f0-9]+)"/)?.[1];assert.ok(token,'packaged UI serves its own auth token');
    for(const path of ['/app.js','/app.css'])assert.equal((await fetch(origin+path,{signal:AbortSignal.timeout(15000)})).status,200);
    const call=async(endpoint,payload={})=>{const response=await fetch(origin+'/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json','x-yingliu-token':token},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const result=await response.json();assert.ok(result.ok,result.error?.message);return result.value;};
    const project=(await call('create',{title:'包外命令行验收',blank:true})).project;
    assert.equal(project.shots.length,0);
    const archive=await call('app.exportProject',{projectId:project.id});
    const restored=await call('app.importProject',{dataBase64:archive.dataBase64});
    assert.notEqual(restored.project.id,project.id);assert.equal(restored.project.title,project.title);
    assert.equal((await call('list')).projects.length,2);
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    let timer;
    await Promise.race([stopped,new Promise(accept=>{timer=setTimeout(()=>{child.kill('SIGKILL');accept();},5000);})]);
    clearTimeout(timer);
  }
}
