// Run with Playwright installed and, optionally, JINSLING_BROWSER_EXECUTABLE.
// This catches the original regression: a painted URL cannot be selected or
// clicked, even if a separate copy control happens to work beside the image.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? `${process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES}/playwright` : 'playwright');
const publicRoot=fileURLToPath(new URL('../../public/',import.meta.url));
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/share-card-view.css"><title>Sharing card test</title><main id="fixture" style="width:min(680px,calc(100vw - 32px));margin:16px auto"></main><script type="module">window.mountCard=async options=>{try{const {createInteractiveShareCard}=await import('/share-card-view.mjs');document.querySelector('#fixture').replaceChildren(createInteractiveShareCard(options));return null;}catch(error){return String(error);}};</script></html>`;
const server=createServer(async(request,response)=>{
  try{
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(fixture);return;}
    const filename=resolve(publicRoot,`.${pathname}`);
    if(!filename.startsWith(`${publicRoot.replace(/\/$/u,'')}${sep}`)){response.writeHead(403);response.end();return;}
    const data=await readFile(filename);
    response.setHeader('Content-Type',filename.endsWith('.css')?'text/css':'text/javascript');
    response.end(data);
  }catch{response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage'],
    ...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:390,height:900}});
  const page=await context.newPage();
  const origin=`http://127.0.0.1:${server.address().port}`;
  const external=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}
    return route.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(()=>typeof window.mountCard==='function');
  const url='https://jinsling-pilot.pages.dev/예약#invite=A%2B_b-9%3D';
  const renderError=await page.evaluate(options=>window.mountCard(options),{
    url,shopName:'진슬링 <img src=x onerror=alert(1)>',kind:'invite',expiresAt:'2026-11-09T01:00:00Z',
  });
  const card=page.locator('article.interactive-share-card');
  assert.equal(await card.locator('a.share-link-anchor').count(),1,
    `The address must be a real link within the same card as the QR. ${renderError||''}`);
  assert.equal(await card.locator('a.share-link-anchor').textContent(),url);
  assert.equal(await card.locator('a.share-link-anchor').getAttribute('href'),url);
  assert.equal(await card.locator('a.share-link-anchor').getAttribute('target'),'_blank');
  assert.match(await card.locator('a.share-link-anchor').getAttribute('rel'),/noopener/u);
  assert.equal(await card.locator('img').count(),0,'Shop name must be text, never HTML.');
  assert.equal(await card.locator('textarea.share-url').inputValue(),url);
  assert.equal(await card.locator('textarea.share-url').getAttribute('readonly'),'');
  assert.equal(await card.locator('details').evaluate(element=>element.open),false);
  assert.equal(await card.locator('a.share-link-anchor').evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    return selection.toString();
  }),url,'The displayed address must be selectable without OCR.');
  assert.match(await card.textContent(),/2026.*11.*09/u,'Show the actual invitation expiry.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,
    'A long invitation address must fit on a 390px screen.');
  const qr=card.locator('canvas');
  const qrPixels=await qr.evaluate(canvas=>{
    const context=canvas.getContext('2d');
    const data=context.getImageData(0,0,canvas.width,canvas.height).data;
    const white=(x,y)=>{const i=(y*canvas.width+x)*4;return data[i]===255&&data[i+1]===255&&data[i+2]===255&&data[i+3]===255;};
    let border=true;
    for(let i=0;i<canvas.width;i++)border&&=white(i,0)&&white(i,canvas.height-1);
    for(let i=0;i<canvas.height;i++)border&&=white(0,i)&&white(canvas.width-1,i);
    let darkPixels=0;for(let i=0;i<data.length;i+=4)if(data[i]<100)darkPixels++;
    return {width:canvas.width,height:canvas.height,border,darkPixels,label:canvas.getAttribute('aria-label')};
  });
  assert.ok(qrPixels.width>=512&&qrPixels.width===qrPixels.height);
  assert.equal(qrPixels.border,true,'The QR must retain white quiet space.');
  assert.ok(qrPixels.darkPixels>1000,'The QR canvas must contain a real matrix.');
  assert.ok(qrPixels.label,'The QR needs a text alternative.');
  assert.equal(await card.locator('a.share-card-preview').getAttribute('href'),url);

  // Denial is a real environment boundary: retain a selected manual-copy field
  // instead of telling the user that a clipboard write succeeded.
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError');}}});
    document.execCommand=()=>false;
  });
  await card.getByRole('button',{name:'링크 복사',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.interactive-share-card details')?.open);
  const manual=await card.locator('textarea.share-url').evaluate(element=>({
    focused:document.activeElement===element,selected:element.value.slice(element.selectionStart,element.selectionEnd),
  }));
  assert.equal(manual.focused,true);assert.equal(manual.selected,url);
  assert.equal(await card.getByRole('button',{name:'링크 복사',exact:true}).isEnabled(),true);

  // A browser without canvas support must still provide the usable URL.
  await page.evaluate(()=>{HTMLCanvasElement.prototype.getContext=()=>null;});
  assert.equal(await page.evaluate(options=>window.mountCard(options),{url:'https://jinsling-pilot.pages.dev/',shopName:'jinSling'}),null);
  assert.equal(await card.locator('a.share-link-anchor').getAttribute('href'),'https://jinsling-pilot.pages.dev/');
  assert.match(await card.textContent(),/QR.*표시/u);
  assert.equal(await card.locator('canvas').count(),0,'Do not leave a blank QR canvas that looks usable.');
  const invalid=await page.evaluate(()=>window.mountCard({url:'https://jinsling-pilot.pages.dev/#reset=private'}));
  assert.match(invalid,/재설정/u,'A password-reset URL must not become a public sharing card.');
  assert.deepEqual(external,[],'Rendering a card must not contact a QR generation service.');
  console.log('PASS interactive sharing card: live address, exact invite URL, mobile layout, QR, copy fallback, safe text, offline rendering.');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
