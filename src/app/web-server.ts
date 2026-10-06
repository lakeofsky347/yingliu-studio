import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createApplication, MemorySecrets } from './application.ts';
import { startUiServer } from './ui-server.ts';
const directory=dirname(fileURLToPath(import.meta.url));
const application=await createApplication({dataDirectory:resolve(process.env.YINGLIU_DATA_DIR||'.local/webdata'),credentials:new MemorySecrets()});
const server=await startUiServer(application,join(directory,'ui'),Number(process.env.YINGLIU_PORT||19430));
console.log('映流 Studio ready: '+server.origin+' (浏览器模式密钥只保存在本进程内存)');
let closing=false;
async function close(){if(closing)return;closing=true;await application.dispose();await server.close();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
