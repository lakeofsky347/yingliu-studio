import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright-core';
import { detectEnvironment } from '../src/host/renderer.ts';

const env=detectEnvironment();
const framePage=`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#123"><script>
addEventListener('message',e=>{if(e.data&&e.data.type==='video-studio/render')parent.postMessage({type:'video-studio/frame',frame:e.data.frame,sceneId:'s'},'*');});
parent.postMessage({type:'video-studio/ready'},'*');</script>`;

async function studio(query:string,run:(page:Page)=>Promise<void>){
  const directory=path.resolve('artifacts/studio-interaction-'+randomUUID());await fs.mkdir(directory,{recursive:true});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url||'/','http://x');
    if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'fixture.js')));return;}
    if(url.pathname==='/studio.css'){
      res.setHeader('Content-Type','text/css');
      const [base,app]=await Promise.all([fs.readFile(path.resolve('src/client/styles.css'),'utf8'),fs.readFile(path.resolve('src/client/app.css'),'utf8')]);
      res.end(app+'\n'+base);return;
    }
    if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}
    if(url.pathname.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(framePage);return;}
    if(url.pathname.startsWith('/thumb/')||url.pathname.startsWith('/assets/')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="#123"/></svg>');return;}
    if(url.pathname==='/events/agent'){res.statusCode=200;res.setHeader('Content-Type','text/event-stream');res.end('data: {"type":"ready"}\n\n');return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><style>html,body{margin:0;height:100%}#root{height:100vh;display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  try{
    await build({entryPoints:[path.resolve('tests/fixtures/studio-harness-entry.tsx')],outfile:path.join(directory,'fixture.js'),bundle:true,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:env.browserPath,headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/?${query}`);
    await page.locator('.vs-stage').first().waitFor();
    await run(page);
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(directory,{recursive:true,force:true});}
}
const calls=(page:Page)=>page.evaluate(()=>((window as any).harnessCalls as {endpoint:string;payload:any}[]).map(call=>call.endpoint));

test('regenerating an existing storyboard asks first and cancelling sends nothing',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.getByRole('button',{name:'生成分镜',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'重新生成分镜？'});await dialog.waitFor();
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal((await calls(page)).includes('generate'),false);
    await page.getByRole('button',{name:'生成分镜',exact:true}).click();
    await page.getByRole('dialog',{name:'重新生成分镜？'}).getByRole('button',{name:'继续',exact:true}).click();
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='generate'&&call.payload.kind==='storyboard'));
  });
});

test('deleting a shot offers undo, and undo flushes save before reaching project history',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark',async page=>{
    await page.locator('.vs-clip').nth(2).click();
    await page.locator('.vs-properties').getByRole('button',{name:'删除',exact:true}).click();
    const toast=page.locator('.vs-toast',{hasText:'已删除镜头「把落日带回家」'});await toast.waitFor();
    assert.equal(await page.locator('.vs-clip').count(),2);
    await toast.getByRole('button',{name:'撤销',exact:true}).click();
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='undo'));
    const endpoints=await calls(page);assert.ok(endpoints.lastIndexOf('save')<endpoints.lastIndexOf('undo'));
  });
});

test('deleting an asset requires confirmation and keeps it when cancelled',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    const row=page.locator('.vs-asset',{hasText:'清晨街景.jpg'});await row.hover();
    await row.getByRole('button',{name:'删除资产「清晨街景.jpg」'}).click();
    const dialog=page.getByRole('dialog',{name:'删除资产「清晨街景.jpg」？'});await dialog.waitFor();
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.locator('.vs-asset').count(),3);
  });
});

test('menu opens drawer panel, focuses tab, and toggles light/dark workbench scheme',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark',async page=>{
    assert.equal(await page.locator('.vs-studio').getAttribute('data-scheme'),'dark');
    assert.equal(await page.locator('.vs-drawer-body').isVisible(),false);
    await page.getByRole('button',{name:'更多操作',exact:true}).click();
    await page.locator('.vs-menu').getByRole('button',{name:'运行环境'}).click();
    const tab=page.getByRole('tab',{name:'运行环境',exact:true});
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='tab');
    assert.equal(await tab.getAttribute('aria-selected'),'true');
    await page.locator('.vs-drawer-body').waitFor({state:'visible'});

    await page.getByRole('button',{name:'更多操作',exact:true}).click();
    await page.locator('.vs-menu').getByRole('button',{name:'切换到浅色工作台'}).click();
    assert.equal(await page.locator('.vs-studio').getAttribute('data-scheme'),'light');
    assert.equal(await page.evaluate(()=>localStorage.getItem('yingliu-workbench-scheme')),'light');
  });
});

test('space plays from a pointer-focused control and the timeline playhead follows',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=dark',async page=>{
    await page.locator('.vs-clip').first().click();
    await page.waitForFunction(()=>!(document.querySelector('button[aria-label="播放"]') as HTMLButtonElement)?.disabled);
    await page.keyboard.press('Space');
    await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
    await page.waitForFunction(()=>Number(document.querySelector('[data-testid="current-frame"]')?.textContent)>=3);
    await page.keyboard.press('Space');
    await page.getByRole('button',{name:'播放',exact:true}).waitFor();
    const transform=await page.locator('.vs-playhead').evaluate(element=>(element as HTMLElement).style.transform);
    assert.match(transform,/translateX\(\d/);
  });
});

test('edits rebuild an outdated preview after ~1.2s without setting global pending',{skip:!env.browserAvailable,timeout:90_000},async()=>{
  await studio('scheme=light',async page=>{
    await page.locator('.vs-clip').first().click();
    await page.evaluate(()=>{
      (window as any).harnessDelay={preview:450};
      (window as any).sawPending=false;
      (window as any).harnessController.subscribe(()=>{if((window as any).harnessController.getSnapshot().pending)(window as any).sawPending=true;});
    });
    const title=page.getByLabel('镜头标题',{exact:true});
    await title.fill('清晨第一缕光');
    await page.waitForFunction(()=>(window as any).harnessController.getSnapshot().snapshot?.project?.revision===5);
    assert.equal((await calls(page)).includes('preview'),false,'Auto-preview waits for ~1.2s debounce after save');
    await page.waitForFunction(()=>(window as any).harnessController.getSnapshot().previewing===true,undefined,{timeout:5000});
    assert.equal(await title.isDisabled(),false,'Preview refresh never locks property inputs');
    await title.fill('清晨街巷');
    await page.waitForFunction(()=>(window as any).harnessCalls.some((call:any)=>call.endpoint==='save'&&call.payload.project.shots[0].title==='清晨街巷'));
    assert.equal(await page.evaluate(()=>Boolean((window as any).sawPending)),false,'Preview refresh never sets global pending');
    await page.waitForFunction(()=>(window as any).harnessController.getSnapshot().snapshot?.previewRevision===6,undefined,{timeout:5000});
    assert.deepEqual(await page.evaluate(()=>(window as any).harnessCalls.filter((call:any)=>call.endpoint==='preview').map((call:any)=>call.payload.expectedRevision)),[5,6]);
  });
});
