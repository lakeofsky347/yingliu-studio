import { contextBridge, ipcRenderer } from 'electron';
// No general IPC, Node or filesystem API is exposed to page content.
contextBridge.exposeInMainWorld('yingliu',Object.freeze({
  call:(endpoint:string,payload:unknown={})=>ipcRenderer.invoke('yingliu:call',endpoint,payload),
  pickProject:()=>ipcRenderer.invoke('yingliu:pick-project'),
}));
