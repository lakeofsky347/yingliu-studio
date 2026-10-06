import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Application } from './application.ts';

/** The editor and untrusted scenes use different loopback origins. */
export async function startUiServer(application:Application,uiDirectory:string,port=0){
  const token=randomBytes(32).toString('hex');let origin='';
  const server=createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
      const url=new URL(req.url??'/',origin);
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://127.0.0.1:*; media-src 'self' http://127.0.0.1:*; frame-src http://127.0.0.1:*; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
      if(url.pathname.startsWith('/api/')){
        if(req.method!=='POST'||req.headers['x-yingliu-token']!==token||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
        const parts:Buffer[]=[];let size=0;
        for await(const part of req){size+=part.length;if(size>24*1024*1024){res.writeHead(413);res.end();return;}parts.push(part);}
        const payload=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
        const value=await application.route(url.pathname.slice(5),payload);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));return;
      }
      if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
      const files:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/app.css':['app.css','text/css; charset=utf-8']};
      const file=files[url.pathname];if(!file){res.writeHead(404);res.end();return;}
      let bytes=await readFile(join(uiDirectory,file[0]));if(file[0]==='index.html')bytes=Buffer.from(bytes.toString().replace('__APP_TOKEN__',token));
      res.writeHead(200,{'Content-Type':file[1]});res.end(req.method==='HEAD'?undefined:bytes);
    }catch{if(!res.headersSent)res.writeHead(400);res.end('Request failed');}
  });
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>accept());});
  const address=server.address();if(!address||typeof address==='string')throw new Error('无法启动编辑器');origin='http://127.0.0.1:'+address.port;
  return {origin,async close(){server.closeAllConnections();await new Promise<void>(accept=>server.close(()=>accept()));}};
}
