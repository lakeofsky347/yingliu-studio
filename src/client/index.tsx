import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { StandaloneStudioApi, StudioController } from './controller.ts';
import './styles.css';
import './app.css';

const api=new StandaloneStudioApi();
const controller=new StudioController(api);
controller.setScheme('dark');
const mount=document.getElementById('root');
if(!mount)throw new Error('缺少应用挂载节点 #root');
createRoot(mount).render(<App controller={controller} api={api}/>);
void controller.load();
const flush=()=>{void controller.flush();};
window.addEventListener('pagehide',flush);
window.addEventListener('blur',flush);
