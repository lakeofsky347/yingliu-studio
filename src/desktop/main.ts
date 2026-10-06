import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication, ENDPOINTS } from '../app/application.ts';
import { startUiServer } from '../app/ui-server.ts';
import type { SecretStore } from '../app/contracts.ts';

app.setName('映流 Studio');
app.commandLine.appendSwitch('site-per-process');
if(process.env.YINGLIU_DATA_DIR)app.setPath('userData',resolve(process.env.YINGLIU_DATA_DIR));
const ownsApplication=app.requestSingleInstanceLock();
if(!ownsApplication)app.quit();
app.on('second-instance',()=>{const window=BrowserWindow.getAllWindows()[0];if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
class NativeSecrets implements SecretStore {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private directory:string){}
  private async read():Promise<Record<string,string>>{try{return JSON.parse(await readFile(join(this.directory,'credentials.encrypted.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}}
  async get(ref:string){await this.queue;const values=await this.read();if(!values[ref])return undefined;if(!safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用');return safeStorage.decryptString(Buffer.from(values[ref],'base64'));}
  private update(ref:string,value?:string){const result=this.queue.then(async()=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('系统安全存储不可用，无法保存模型密钥');
    const values=await this.read();if(value===undefined)delete values[ref];else values[ref]=safeStorage.encryptString(value).toString('base64');
    await mkdir(this.directory,{recursive:true});const file=join(this.directory,'credentials.encrypted.json');await writeFile(file+'.tmp',JSON.stringify(values),{mode:0o600});await rename(file+'.tmp',file);
  });this.queue=result.catch(()=>{});return result;}
  async set(ref:string,value:string){await this.update(ref,value);}
  async delete(ref:string){await this.update(ref);}
}
let closing=false,preparing=false,dispose:(()=>Promise<void>)|undefined,prepareQuit:(()=>Promise<void>)|undefined;
if(ownsApplication)void app.whenReady().then(async()=>{
  const dataDirectory=app.getPath('userData');
  const application=await createApplication({dataDirectory,credentials:new NativeSecrets(dataDirectory),reveal:async path=>shell.showItemInFolder(path)});
  const server=await startUiServer(application,join(__dirname,'../ui'));
  dispose=async()=>{await application.dispose();await server.close();};
  const editorSession=session.fromPartition('persist:yingliu-editor');
  editorSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  editorSession.setPermissionCheckHandler(()=>false);
  const window=new BrowserWindow({width:1600,height:1000,minWidth:1100,minHeight:700,title:'映流 Studio',backgroundColor:'#0e1117',
    webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,session:editorSession}});
  const trusted=(event:Electron.IpcMainInvokeEvent)=>event.sender===window.webContents&&event.senderFrame!==null&&event.senderFrame.parent===null&&event.senderFrame.frameTreeNodeId===window.webContents.mainFrame.frameTreeNodeId&&new URL(event.senderFrame.url).origin===server.origin;
  ipcMain.handle('yingliu:call',(event,endpoint:unknown,payload:unknown)=>{if(!trusted(event)||typeof endpoint!=='string'||!ENDPOINTS.has(endpoint))throw new Error('此窗口无法调用应用服务');return application.route(endpoint,payload);});
  ipcMain.handle('yingliu:pick-project',async event=>{if(!trusted(event))throw new Error('此窗口无法打开文件');const result=await dialog.showOpenDialog(window,{title:'打开影片工程目录',properties:['openDirectory'],defaultPath:join(dataDirectory,'projects')});return result.canceled?null:result.filePaths[0]??null;});
  ipcMain.handle('yingliu:pick-executable',async event=>{if(!trusted(event))throw new Error('此窗口无法打开文件');const result=await dialog.showOpenDialog(window,{title:'选择本地可执行文件',properties:['openFile']});return result.canceled?null:result.filePaths[0]??null;});
  ipcMain.handle('yingliu:reset-scene',async event=>{
    if(!trusted(event))throw new Error('此窗口不能重新加载画面');
    const editorPid=window.webContents.mainFrame.osProcessId,origins=new Set<string>();
    function visit(frame:Electron.WebFrameMain){for(const child of frame.frames){try{const url=new URL(child.url);if(url.hostname==='localhost'&&child.osProcessId!==editorPid)origins.add(url.origin);}catch{}visit(child);}}
    visit(window.webContents.mainFrame);if(!origins.size)return {reset:false};
    const debuggerPort=window.webContents.debugger,attachedHere=!debuggerPort.isAttached();let reset=false;
    const command=(method:string,params:unknown={},sessionId?:string)=>{let timer:ReturnType<typeof setTimeout>;return Promise.race([debuggerPort.sendCommand(method,params,sessionId),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('画面恢复超时，请修复源码后重新打开工程')),3000);})]).finally(()=>clearTimeout(timer));};
    try{
      if(attachedHere)debuggerPort.attach('1.3');
      const result=await command('Target.getTargets') as {targetInfos:{targetId:string;type:string;url:string}[]};
      for(const target of result.targetInfos){let origin='';try{origin=new URL(target.url).origin;}catch{}if(target.type!=='iframe'||!origins.has(origin))continue;
        const {sessionId}=await command('Target.attachToTarget',{targetId:target.targetId,flatten:true}) as {sessionId:string};
        try{await command('Runtime.terminateExecution',{},sessionId);await command('Page.navigate',{url:'about:blank'},sessionId);reset=true;}
        finally{await command('Target.detachFromTarget',{sessionId}).catch(()=>{});}
      }
      return {reset};
    }finally{if(attachedHere&&debuggerPort.isAttached())debuggerPort.detach();}
  });
  ipcMain.handle('yingliu:export-project',async(event,projectId:string)=>{
    if(!trusted(event))throw new Error('此窗口无法备份工程');
    const snapshot=await application.backend.call('current',{projectId});if(!snapshot.project)throw new Error('工程不存在');
    const result=await dialog.showSaveDialog(window,{title:'备份可编辑工程',defaultPath:(snapshot.project.title.replace(/[<>:"/\\|?*]/g,'-')||'影片')+'.yingliu',filters:[{name:'映流工程包',extensions:['yingliu']}]});
    return result.canceled||!result.filePath?null:application.route('app.exportProject',{projectId,path:result.filePath});
  });
  ipcMain.handle('yingliu:import-project',async event=>{
    if(!trusted(event))throw new Error('此窗口无法导入工程');
    const result=await dialog.showOpenDialog(window,{title:'导入映流工程包',properties:['openFile'],filters:[{name:'映流工程包',extensions:['yingliu']}]});
    return result.canceled?null:application.route('app.importProject',{path:result.filePaths[0]});
  });
  const closeWaiters=new Map<string,(result:{ok:boolean;message?:string})=>void>();
  ipcMain.handle('yingliu:close-result',(event,id:string,result:{ok:boolean;message?:string})=>{if(!trusted(event))throw new Error('此窗口不能确认保存');closeWaiters.get(id)?.({ok:result?.ok===true,message:typeof result?.message==='string'?result.message:undefined});});
  const flushEditor=()=>new Promise<{ok:boolean;message?:string}>(accept=>{
    const id=randomUUID();const timer=setTimeout(()=>{closeWaiters.delete(id);accept({ok:false,message:'编辑器暂未回应保存请求。继续编辑可保留当前窗口。'});},7000);
    closeWaiters.set(id,result=>{clearTimeout(timer);closeWaiters.delete(id);accept(result);});window.webContents.send('yingliu:before-close',id);
  });
  prepareQuit=async()=>{
    if(preparing||closing)return;preparing=true;
    try{
      const saved=window.isDestroyed()?{ok:true}:await flushEditor();
      if(!saved.ok){const choice=await dialog.showMessageBox(window,{type:'warning',title:'工程尚未保存',message:saved.message??'工程尚未保存',buttons:['继续编辑','放弃未保存并退出'],defaultId:0,cancelId:0});if(choice.response===0)return;}
      const registry=await application.backend.call<{projects:{id:string}[]}>('list');let running=application.conversation.hasActiveTurn();
      for(const project of registry.projects){const state=await application.backend.call('current',{projectId:project.id});if(state.task?.status==='running'){running=true;break;}}
      if(running){const choice=await dialog.showMessageBox(window,{type:'question',title:'还有制作任务在运行',message:'退出会取消当前制作任务。已保存的工程和任务记录将保留，重新打开后可以重试。',buttons:['继续制作','取消任务并退出'],defaultId:0,cancelId:0});if(choice.response===0)return;}
      closing=true;await dispose?.();app.quit();
    }catch(error){await dialog.showMessageBox(window,{type:'error',title:'关闭前保存失败',message:error instanceof Error?error.message:'关闭前保存失败，请保留窗口重试。'});}finally{preparing=false;}
  };
  window.on('close',event=>{if(!closing){event.preventDefault();void prepareQuit?.();}});
  window.webContents.setWindowOpenHandler(({url})=>{
    const target=new URL(url);if(target.hostname==='localhost'&&/^\/\.studio\/inspection\/[\w-]+\.png$/.test(target.pathname))return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{preload:undefined,contextIsolation:true,nodeIntegration:false,sandbox:true}}};
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==server.origin)event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('will-frame-navigate',event=>{const url=new URL(event.url);if(event.isMainFrame?url.origin!==server.origin:url.hostname!=='localhost'&&url.protocol!=='about:')event.preventDefault();});
  window.webContents.on('render-process-gone',()=>{if(!closing)void window.loadURL(server.origin);});
  await window.loadURL(server.origin);window.setMenuBarVisibility(false);
  console.log('映流 Studio desktop ready');
}).catch(error=>{console.error(error instanceof Error?error.message:'启动失败');closing=true;app.quit();});
app.on('window-all-closed',()=>{if(!closing)void prepareQuit?.();});
app.on('before-quit',event=>{if(closing||!ownsApplication)return;event.preventDefault();if(prepareQuit)void prepareQuit();else{closing=true;void (dispose?.()??Promise.resolve()).finally(()=>app.quit());}});
