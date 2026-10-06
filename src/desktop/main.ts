import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApplication, ENDPOINTS } from '../app/application.ts';
import { startUiServer } from '../app/ui-server.ts';
import type { SecretStore } from '../app/contracts.ts';

app.setName('映流 Studio');
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
let closing=false,dispose:(()=>Promise<void>)|undefined;
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
  const trusted=(event:Electron.IpcMainInvokeEvent)=>event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&new URL(event.senderFrame.url).origin===server.origin;
  ipcMain.handle('yingliu:call',(event,endpoint:unknown,payload:unknown)=>{if(!trusted(event)||typeof endpoint!=='string'||!ENDPOINTS.has(endpoint))throw new Error('此窗口无法调用应用服务');return application.route(endpoint,payload);});
  ipcMain.handle('yingliu:pick-project',async event=>{if(!trusted(event))throw new Error('此窗口无法打开文件');const result=await dialog.showOpenDialog(window,{title:'打开影片工程目录',properties:['openDirectory'],defaultPath:join(dataDirectory,'projects')});return result.canceled?null:result.filePaths[0]??null;});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==server.origin)event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  await window.loadURL(server.origin);window.setMenuBarVisibility(false);
  console.log('映流 Studio desktop ready');
}).catch(error=>{console.error(error instanceof Error?error.message:'启动失败');app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(closing)return;event.preventDefault();closing=true;void (dispose?.()??Promise.resolve()).finally(()=>app.quit());});
