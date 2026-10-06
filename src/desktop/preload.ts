import { contextBridge, ipcRenderer } from 'electron';
// No general IPC, Node or filesystem API is exposed to page content.
if(process.isMainFrame)contextBridge.exposeInMainWorld('yingliu',Object.freeze({
  call:(endpoint:string,payload:unknown={})=>ipcRenderer.invoke('yingliu:call',endpoint,payload),
  pickProject:()=>ipcRenderer.invoke('yingliu:pick-project'),
  exportProject:(projectId:string)=>ipcRenderer.invoke('yingliu:export-project',projectId),
  importProject:()=>ipcRenderer.invoke('yingliu:import-project'),
    pickExecutable:()=>ipcRenderer.invoke('yingliu:pick-executable'),
    resetScene:()=>ipcRenderer.invoke('yingliu:reset-scene'),
  onBeforeClose:(handler:()=>Promise<{ok:boolean;message?:string}>)=>{
    const listener=(_event:unknown,requestId:string)=>{void Promise.resolve().then(handler).then(result=>ipcRenderer.invoke('yingliu:close-result',requestId,result)).catch(()=>ipcRenderer.invoke('yingliu:close-result',requestId,{ok:false,message:'工程未能保存，请继续编辑后重试。'}));};
    ipcRenderer.on('yingliu:before-close',listener);return ()=>ipcRenderer.removeListener('yingliu:before-close',listener);
  },
}));
