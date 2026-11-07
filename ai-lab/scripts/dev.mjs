// Loopback-only synthetic preview. Never part of the deployed Worker bundle.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleLab} from '../src/server.mjs';
import {createLabDatabase} from '../tests/sqlite-d1.mjs';

const assets=fileURLToPath(new URL('../public/',import.meta.url));
const database=createLabDatabase();
const ownerCode=randomBytes(32).toString('base64url'),memberCode=randomBytes(32).toString('base64url');
const env={LAB_STAGE:'sandbox',AI_MODE:'simulation',FREE_PLAN_CONFIRMED:'false',LAB_DB:database.binding,LAB_OWNER_CODE:ownerCode,LAB_MEMBER_CODE:memberCode};
const portArg=process.argv.indexOf('--port');
const port=Number(portArg>=0?process.argv[portArg+1]:4177);
const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=createServer(async(req,res)=>{
  if(![`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`].includes(req.headers.host)){res.writeHead(400);res.end('Invalid host');return;}
  const origin=`http://${req.headers.host}`;
  const url=new URL(req.url,origin);
  try{
    if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(url.pathname==='/__lab/demo'){
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({owner_code:ownerCode,member_code:memberCode}));return;
    }
    if(url.pathname.startsWith('/api/')){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers(req.headers);
      const local=(headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('jinsling_lab_local='));
      headers.delete('Cookie');
      if(local)headers.set('Cookie',local.replace(/^jinsling_lab_local=/,'__Host-jinsling_lab_session='));
      // The browser's HTTP origin is authoritative during this loopback preview.
      const request=new Request(url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      const response=await handleLab(request,env);
      for(const [name,value] of response.headers)if(name!=='set-cookie')res.setHeader(name,value);
      const cookies=response.headers.getSetCookie().map(value=>value.replace(/^__Host-jinsling_lab_session=/,'jinsling_lab_local=').replace(/;\s*Secure/ig,''));
      if(cookies.length)res.setHeader('Set-Cookie',cookies);
      res.statusCode=response.status;res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    const filename=resolve(assets,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!filename.startsWith(resolve(assets)+sep)){res.writeHead(404);res.end();return;}
    const bytes=await readFile(filename);
    res.writeHead(200,{'Content-Type':types[extname(filename)]||'application/octet-stream','Cache-Control':'no-store','Content-Security-Policy':csp,'X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'preview_error',message:'미리보기 요청을 처리하지 못했어요.'}}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`AI lab synthetic preview: http://127.0.0.1:${server.address().port}/ (simulation; in-memory test data only)`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{database.close();process.exit(0);}));
