/** Browser acceptance for the upstream sync, with isolated data and no provider requests. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createApplication, MemorySecrets, type Application } from '../src/app/application.ts';
import { startUiServer } from '../src/app/ui-server.ts';
import type { SceneSource, StudioSnapshot, VideoProject, VideoStyle } from '../src/shared/types.ts';

const workspace=resolve('.'),output=join(workspace,'artifacts/acceptance-upstream-sync');
const temporary=await mkdtemp(join(tmpdir(),'yingliu-upstream-sync-'));
await mkdir(output,{recursive:true});
const checks:{name:string;status:'PASS';details?:unknown}[]=[],pageErrors:string[]=[],externalRequests:string[]=[];
let application:Application|undefined,browser:Browser|undefined,page:Page|undefined;
let server:Awaited<ReturnType<typeof startUiServer>>|undefined,failure:unknown,stage='启动';
let projectId='',originalStyle:VideoStyle|undefined,revisionBeforeSave:number|undefined,revisionAfterSave:number|undefined;
const filmTitle='上游同步 · 风格与草稿验收',customName='验收 · 奶油纸张',customPrompt='奶油色纸张背景，深棕色中文标题，轻缓的镜头节奏。';
const pass=(name:string,details?:unknown)=>{checks.push({name,status:'PASS',...(details===undefined?{}:{details})});process.stdout.write('PASS '+name+'\n');};
async function until(read:()=>Promise<boolean>,label:string,timeout=60_000){
  const deadline=Date.now()+timeout;
  while(!await read()){
    if(Date.now()>deadline)throw new Error(label+'超时');
    await new Promise(accept=>setTimeout(accept,100));
  }
}
async function current():Promise<StudioSnapshot>{return application!.backend.call('current',projectId?{projectId}:{});}
async function styleList():Promise<VideoStyle[]>{return (await application!.backend.call<{styles:VideoStyle[]}>('styles.list')).styles;}
async function openFilm(){
  await page!.getByRole('heading',{name:'我的影片',exact:false}).waitFor();
  await page!.getByRole('button',{name:filmTitle,exact:true}).click();
  await page!.locator('.vs-studio').waitFor();
  await page!.locator('.vs-shotchip').first().waitFor();
}

try{
  const ui=join(temporary,'ui');await mkdir(ui);
  await build({entryPoints:[join(workspace,'src/client/index.tsx')],bundle:true,format:'esm',platform:'browser',outfile:join(ui,'app.js'),loader:{'.css':'css'},target:['chrome120'],logLevel:'silent'});
  await writeFile(join(ui,'index.html'),await readFile(join(workspace,'public/index.html')));
  application=await createApplication({dataDirectory:join(temporary,'data'),credentials:new MemorySecrets()});
  server=await startUiServer(application,ui);
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1600,height:1100}});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(['http:','https:'].includes(url.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){
      externalRequests.push(url.origin+url.pathname);return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page=await context.newPage();page.setDefaultTimeout(15_000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(server.origin);await page.getByRole('heading',{name:'我的影片',exact:false}).waitFor();

  stage='自定义风格与文件导入';
  await page.getByRole('button',{name:'视频风格库',exact:true}).click();
  const library=page.getByRole('dialog',{name:'视频制作风格库',exact:true});
  await library.getByRole('button',{name:'新建自定义风格',exact:true}).click();
  await library.getByLabel('风格名称',{exact:true}).fill(customName);
  await library.getByLabel('简短说明（可选）',{exact:true}).fill('仅用于隔离浏览器验收');
  await library.getByLabel('风格描述',{exact:true}).fill(customPrompt);
  await library.getByRole('button',{name:'保存风格',exact:true}).click();
  await until(async()=>(await styleList()).some(style=>style.name===customName),'自定义风格保存');
  originalStyle=(await styleList()).find(style=>style.name===customName)!;
  await library.locator('input[type="file"]').first().setInputFiles([
    {name:'验收水墨.md',mimeType:'text/markdown',buffer:Buffer.from('# 验收 · 水墨\n\n白色纸面、淡墨山水和克制的字幕。')},
    {name:'验收极简.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({name:'验收 · 极简',description:'JSON 导入',prompt:'纯色背景，几何形状和清楚的信息层次。'}))},
  ]);
  await until(async()=>{const styles=await styleList();return styles.some(style=>style.name==='验收 · 水墨'&&style.sourceFormat==='markdown')&&styles.some(style=>style.name==='验收 · 极简'&&style.sourceFormat==='json');},'Markdown 和 JSON 导入');
  await library.locator('[data-style-id]').filter({has:page.getByRole('heading',{name:customName,exact:true})}).getByRole('button',{name:'用于新影片',exact:true}).waitFor();
  pass('首页风格库通过真实表单保存自定义风格并导入 Markdown 与 JSON',{formats:(await styleList()).map(style=>style.sourceFormat)});

  stage='用风格创建影片';
  await library.locator(`[data-style-id="${originalStyle.id}"]`).getByRole('button',{name:'用于新影片',exact:true}).click();
  const wizard=page.getByRole('dialog',{name:'先写下这部影片的简报',exact:true});
  assert.equal(await wizard.getByLabel('自定义视频风格',{exact:true}).inputValue(),originalStyle.id);
  await wizard.getByLabel('影片名称',{exact:true}).fill(filmTitle);
  await wizard.getByLabel('主题与创作简报',{exact:true}).fill('验证上游新功能；全程手动编辑，不请求模型服务。');
  await wizard.getByLabel('目标片长（秒）',{exact:true}).fill('2');
  await wizard.getByRole('button',{name:'创建空白影片',exact:true}).click();
  await page.locator('.vs-studio').waitFor();
  const created=await current();assert.ok(created.project);projectId=created.project.id;
  assert.deepEqual(created.project.videoStyle,originalStyle);
  for(let count=1;count<=2;count++){
    await page.getByTitle('添加镜头',{exact:true}).click();
    await until(async()=>(await current()).project?.shots.length===count,'添加验收镜头 '+count);
    await page.locator('.yl-header .yl-project-switch').waitFor();
  }
  // Prepare a valid, small render fixture; source edits and source save still go through the UI.
  const setup=await current(),fixture=structuredClone(setup.project!);
  fixture.target={width:320,height:180,fps:{num:12,den:1},audioMode:'none',quality:'small'};
  fixture.targetDuration=2;fixture.shots=fixture.shots.map(shot=>({...shot,durationFrames:12}));
  fixture.extensions.graphEdges=fixture.shotOrder.map((from,index)=>({from,to:fixture.shotOrder[index+1]||'film-output'}));
  await application.backend.call('save',{projectId,expectedRevision:setup.project!.revision,project:fixture});
  pass('新影片保存所选风格的完整副本',{projectId,styleId:originalStyle.id});

  stage='风格副本独立性';
  await page.getByRole('button',{name:'风格库',exact:true}).click();
  const usedCard=library.locator(`[data-style-id="${originalStyle.id}"]`);
  await usedCard.getByRole('button',{name:'编辑',exact:true}).click();
  await library.getByPlaceholder('写下画面、色彩、镜头、节奏和声音等制作要求…',{exact:true}).fill('修改风格库版本，不应改变已有影片。');
  await library.getByRole('button',{name:'保存风格',exact:true}).click();
  await until(async()=>(await styleList()).find(style=>style.id===originalStyle!.id)?.prompt!==customPrompt,'更新风格库');
  page.once('dialog',dialog=>void dialog.accept());
  await usedCard.getByRole('button',{name:'删除',exact:true}).click();
  await until(async()=>!(await styleList()).some(style=>style.id===originalStyle!.id),'删除风格库原条目');
  assert.deepEqual((await current()).project!.videoStyle,originalStyle);
  const persisted=JSON.parse(await readFile(join((await current()).root!,'project.json'),'utf8')) as VideoProject;
  assert.deepEqual(persisted.videoStyle,originalStyle);
  await library.getByRole('button',{name:'关闭风格库',exact:true}).click();
  await page.reload();await openFilm();
  assert.deepEqual((await current()).project!.videoStyle,originalStyle);
  pass('修改及删除风格库条目后，已有影片的风格副本仍在磁盘和刷新后的工程中');

  stage='源码草稿跨镜头与面板恢复';
  const firstShot=(await current()).project!.shotOrder[0]!;
  await page.locator('.vs-shotchip').first().click();
  await page.getByRole('tab',{name:'前端源码',exact:true}).click();
  const htmlEditor=page.getByRole('textbox',{name:'HTML 源码',exact:true});
  await htmlEditor.waitFor();const originalHtml=await htmlEditor.inputValue();
  const draftHtml=originalHtml+'\n<!-- upstream-sync-retained-draft -->';
  await htmlEditor.fill(draftHtml);
  await page.getByText('草稿已保留 · 未提交',{exact:true}).waitFor();
  assert.ok(!(await application.backend.call<SceneSource>('source',{projectId,shotId:firstShot})).html.includes('upstream-sync-retained-draft'));
  await page.locator('.vs-shotchip').nth(1).click();
  await until(async()=>await htmlEditor.inputValue()!==draftHtml,'切换第二镜头源码');
  await page.getByRole('tab',{name:'声音与配音',exact:true}).click();
  await page.getByRole('tab',{name:'前端源码',exact:true}).click();
  await page.locator('.vs-shotchip').first().click();
  await until(async()=>await htmlEditor.inputValue()===draftHtml,'返回第一镜头草稿');
  pass('源码草稿切换镜头和工作面板后恢复，未提前写入已保存源码');

  stage='刷新后草稿恢复与保存';
  await page.reload();await openFilm();
  await page.locator('.vs-shotchip').first().click();
  await page.getByRole('tab',{name:'前端源码',exact:true}).click();
  await htmlEditor.waitFor();await until(async()=>await htmlEditor.inputValue()===draftHtml,'页面刷新后草稿恢复');
  await page.getByText('草稿已保留 · 未提交',{exact:true}).waitFor();
  const cached=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.includes('source-drafts')).map(([,value])=>value));
  assert.ok(cached.some(value=>value.includes('upstream-sync-retained-draft')));
  pass('页面刷新后源码草稿从本机缓存恢复');
  revisionBeforeSave=(await current()).project!.revision;
  await page.getByRole('button',{name:'保存源码',exact:true}).click();
  await until(async()=>{const value=await current();return value.project!.revision===revisionBeforeSave!+1&&value.task?.status!=='running';},'保存源码与真实场景检查',120_000);
  const saved=await current();revisionAfterSave=saved.project!.revision;
  assert.equal(saved.task?.status,'complete',saved.task?.error);
  assert.equal((await application.backend.call<SceneSource>('source',{projectId,shotId:firstShot})).html,draftHtml);
  await page.getByText('源码已保存',{exact:true}).waitFor();
  const remaining=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.includes('source-drafts')).map(([,value])=>value));
  assert.ok(!remaining.some(value=>value.includes('upstream-sync-retained-draft')));
  assert.equal(await page.getByRole('button',{name:'保存源码',exact:true}).isDisabled(),true);
  await page.locator('.vs-task.is-complete').waitFor();
  pass('保存源码提交一个新 revision，真实 Chromium 场景检查通过并清除草稿',{revisionBeforeSave,revisionAfterSave});
  await page.screenshot({path:join(output,'upstream-sync.png'),fullPage:true});
  await rm(join(output,'failure.png'),{force:true});
  assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);
  pass('所有交互无浏览器未捕获异常，未发出外部网络请求');
}catch(error){
  failure=error;
  if(page)await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});
}finally{
  await browser?.close();await server?.close();await application?.dispose();
  await writeFile(join(output,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),status:failure?'FAIL':'PASS',stage,checks,pageErrors,externalRequests,projectId,styleId:originalStyle?.id,revisionBeforeSave,revisionAfterSave,evidence:'真实 headless Chromium 界面；隔离临时数据与 MemorySecrets；源码保存进行真实场景检查',realProvider:'NOT_CALLED',screenshot:'upstream-sync.png',...(failure?{error:failure instanceof Error?failure.stack:String(failure)}:{})},null,2)+'\n');
  await rm(temporary,{recursive:true,force:true});
}
if(failure)throw failure;
