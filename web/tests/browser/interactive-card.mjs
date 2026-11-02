// Optional real-browser regression for the app's interactive sharing surface.
// Starts a loopback-only static server; all app APIs are synthetic and intercepted.
// No customer data, production endpoints, external QR services, or DB writes.
// JINSLING_BROWSER_EXECUTABLE=/path/to/chromium node web/tests/browser/interactive-card.mjs
// Set JINSLING_BROWSER_BASE_REF to a local Git ref to reproduce the pre-fix failure.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const assets=fileURLToPath(new URL('../../public/',import.meta.url));
const output=resolve(process.env.JINSLING_BROWSER_OUTPUT||'/tmp/jinsling-interactive-card');
const baseRef=process.env.JINSLING_BROWSER_BASE_REF;
if(baseRef)assert.match(baseRef,/^[A-Za-z0-9][A-Za-z0-9_./~^-]*$/,'Use a local Git ref.');
const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'";
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.pdf':'application/pdf'};
const server=createServer(async(request,response)=>{
  const pathname=new URL(request.url,'http://127.0.0.1').pathname;
  if(pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
  try{
    const relative=decodeURIComponent(pathname==='/'?'/index.html':pathname).slice(1);
    const filename=resolve(assets,relative);
    if(!filename.startsWith(resolve(assets)+sep))throw new Error('Outside public assets.');
    const data=baseRef
      ? execFileSync('git',['show',`${baseRef}:web/public/${relative}`],{cwd:root,stdio:['ignore','pipe','ignore']})
      : await readFile(filename);
    response.writeHead(200,{'Content-Type':mime[extname(filename)]||'application/octet-stream','Content-Security-Policy':csp,'Cache-Control':'no-store'});
    response.end(data);
  }catch{response.writeHead(404,{'Content-Type':'text/plain'});response.end('Not found');}
});
await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
const origin=`http://127.0.0.1:${server.address().port}`;
await mkdir(output,{recursive:true});
let browser;
const errors=[],externalRequests=[],unexpectedApis=[];
let passed=0;
const owner={id:'synthetic-owner',name:'가상 사장님',username:'synthetic_owner',role:'admin',status:'approved'};
const session={configured:true,auth_ready:true,user:owner,settings:{shop_name:'jinSling 예약',booking_window_days:30,cancel_before_minutes:0,contact_phone:'',member_limit:100,registration_open:true}};
const inviteToken='synthetic-card-invite_0123456789';
const inviteExpiry='2030-11-09T03:00:00.000Z';
const ok=(route,data)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data})});

async function contextFor({authenticated=true,javaScriptEnabled=true}={}){
  const context=await browser.newContext({viewport:{width:1280,height:1050},locale:'ko-KR',timezoneId:'Asia/Seoul',javaScriptEnabled});
  const apiRequests=[];
  context.on('page',page=>{
    page.setDefaultTimeout(6_000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/content.security.policy|refused to (?:load|execute|apply|connect)/iu.test(message.text()))errors.push(message.text());});
  });
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){externalRequests.push(url.href);return route.abort();}
    if(url.pathname==='/__preview/identities')return route.fulfill({status:404,body:''});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    apiRequests.push(url.pathname);
    if(!authenticated)return route.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});
    if(url.pathname==='/api/session')return ok(route,session);
    if(url.pathname==='/api/bookings')return ok(route,{items:[]});
    if(url.pathname==='/api/admin/users')return ok(route,{items:[owner]});
    if(url.pathname==='/api/admin/invites')return ok(route,route.request().method()==='POST'
      ? {invite_token:inviteToken,expires_at:inviteExpiry}:{items:[]});
    unexpectedApis.push(url.pathname);
    return route.fulfill({status:500,contentType:'application/json',body:'{"ok":false}'});
  });
  return {context,apiRequests,page:await context.newPage()};
}
async function step(name,task){await task();passed++;console.log(`PASS ${name}`);}
async function selectedText(anchor){
  return anchor.evaluate(node=>{
    const selection=window.getSelection(),range=document.createRange();
    range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);
    const text=selection.toString();selection.removeAllRanges();return text;
  });
}
async function openInNewTab(context,anchor,expected){
  assert.equal(await anchor.getAttribute('target'),'_blank');
  assert.match(await anchor.getAttribute('rel'),/noopener/u);
  const pending=context.waitForEvent('page');await anchor.click();
  const popup=await pending;
  try{
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(),expected);
    assert.equal(await popup.evaluate(()=>window.opener===null),true);
  }finally{await popup.close();}
}
async function assertMobile(page){
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'The document must fit a 390px phone screen.');
  assert.equal(await page.locator('.interactive-share-card').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'The complete URL must wrap inside the card.');
}

try{
  browser=await chromium.launch({...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{}),headless:true,args:['--disable-dev-shm-usage']});
  const admin=await contextFor();
  const {page,context}=admin;
  await page.goto(origin);
  await page.getByRole('button',{name:/회원 관리/u}).click();
  await page.getByRole('button',{name:'예약 안내 · QR',exact:true}).click();
  await page.locator('#dialog canvas').waitFor();
  await step('public modal combines real selectable URL and QR in one card',async()=>{
    // This is deliberately the first assertion: the old full PNG preview fails it.
    assert.equal(await page.locator('#dialog .interactive-share-card').count(),1,
      'The public dialog needs one unified interactive card, not separate text above a flat image.');
    const card=page.locator('#dialog .interactive-share-card');
    assert.equal(await card.locator('a.share-link-anchor').count(),1);
    assert.equal(await card.locator('a.share-card-preview canvas').count(),1);
    assert.equal(await card.locator('a.share-link-anchor').textContent(),origin+'/');
    assert.equal(await selectedText(card.locator('a.share-link-anchor')),origin+'/');
    assert.equal(await card.locator('a.share-link-anchor').getAttribute('href'),origin+'/');
    assert.equal(await card.locator('a.share-card-preview').getAttribute('href'),origin+'/');
    const positions=await card.evaluate(node=>{
      const a=node.querySelector('.share-link-anchor').getBoundingClientRect(),qr=node.querySelector('canvas').getBoundingClientRect();
      return {addressBottom:a.bottom,qrTop:qr.top};
    });
    assert.ok(positions.addressBottom<=positions.qrTop,'The clickable address must be above the QR.');
  });
  await step('address and QR open the exact booking root without an opener',async()=>{
    for(const selector of ['a.share-link-anchor','a.share-card-preview']){
      await openInNewTab(context,page.locator(`#dialog .interactive-share-card ${selector}`),origin+'/');
    }
  });
  await step('native browser clipboard copies the actual public URL',async()=>{
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
    await page.bringToFront();
    await page.locator('#dialog .interactive-share-card').getByRole('button',{name:'링크 복사',exact:true}).click();
    await page.locator('#dialog .share-card-copy-feedback').filter({hasText:'주소를 복사했어요.'}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),origin+'/');
  });
  await step('public modal shares the guide, lazily downloads a valid PNG, and fits a phone',async()=>{
    const guide=page.getByRole('link',{name:'안내 카드 열기',exact:true});
    const href=new URL(await guide.getAttribute('href'),origin);
    assert.equal(href.origin,origin);assert.equal(href.pathname,'/share.html');assert.equal(href.hash,'');
    await page.getByRole('button',{name:'안내 카드 링크 복사',exact:true}).click();
    await page.getByText('안내 카드 링크를 복사했어요.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),href.href);
    const printOptions=page.locator('#dialog .share-print-options');
    assert.equal(await printOptions.evaluate(node=>node.open),false);
    await printOptions.getByText('인쇄하거나 사진으로 보내기',{exact:true}).click();
    const pendingDownload=page.waitForEvent('download');
    await printOptions.getByRole('button',{name:'이미지 저장 (PNG)',exact:true}).click();
    const download=await pendingDownload;
    assert.equal(download.suggestedFilename(),'jinSling-booking-QR.png');
    const pngPath=join(output,'interactive-public-card-export.png');
    await download.saveAs(pngPath);
    const png=await readFile(pngPath);
    assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    const dimensions=await page.evaluate(async base64=>{
      const image=new Image();image.src=`data:image/png;base64,${base64}`;
      await image.decode();return [image.naturalWidth,image.naturalHeight];
    },png.toString('base64'));
    assert.deepEqual(dimensions,[1080,1080],'The first export click must produce a decodable full-size PNG.');
    await printOptions.getByText('인쇄하거나 사진으로 보내기',{exact:true}).click();
    await assertMobile(page);
    await page.locator('#dialog .interactive-share-card').screenshot({path:join(output,'interactive-public-card-mobile.png')});
  });
  await page.getByRole('button',{name:'창 닫기',exact:true}).click();
  await page.getByRole('button',{name:'＋ 1회용 초대',exact:true}).click();
  await page.locator('#dialog .interactive-share-card canvas').waitFor();
  await step('the real invitation dialog keeps its one-time address and expiry together',async()=>{
    const card=page.locator('#dialog .interactive-share-card'),url=`${origin}/#invite=${encodeURIComponent(inviteToken)}`;
    assert.equal(await card.count(),1);
    assert.equal(await selectedText(card.locator('a.share-link-anchor')),url);
    assert.equal(await card.locator('a.share-link-anchor').getAttribute('href'),url);
    assert.equal(await card.locator('a.share-card-preview').getAttribute('href'),url);
    assert.match(await card.innerText(),/2030/u);assert.match(await card.innerText(),/승인/u);
    await card.getByRole('button',{name:'링크 복사',exact:true}).click();
    await card.locator('.share-card-copy-feedback').filter({hasText:'주소를 복사했어요.'}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),url);
    await assertMobile(page);
  });
  await context.close();

  const guide=await contextFor({authenticated:false});
  await step('public guide loads without a session or any API request',async()=>{
    const response=await guide.page.goto(`${origin}/share.html`);
    assert.equal(response.status(),200);
    await guide.page.locator('.interactive-share-card canvas').waitFor();
    const anchor=guide.page.locator('.interactive-share-card a.share-link-anchor');
    assert.equal(await selectedText(anchor),origin+'/');
    assert.equal(await anchor.getAttribute('href'),origin+'/');
    assert.deepEqual(guide.apiRequests,[],'Customer guide must work when the authentication and DB APIs are unavailable.');
    assert.deepEqual(await guide.context.cookies(),[],'The guide must not need or create a login session.');
    await guide.page.evaluate(()=>document.fonts.ready);
    await guide.page.locator('.interactive-share-card').screenshot({path:join(output,'interactive-public-card-desktop.png')});
    await assertMobile(guide.page);
    await guide.page.screenshot({path:join(output,'interactive-guide-mobile.png'),fullPage:true});
  });
  await step('public guide URL can be opened by an unauthenticated recipient',async()=>{
    await openInNewTab(guide.context,guide.page.locator('.interactive-share-card a.share-link-anchor'),origin+'/');
  });
  await guide.context.close();

  const noScript=await contextFor({authenticated:false,javaScriptEnabled:false});
  await step('without JavaScript a visible ordinary booking link still works',async()=>{
    const response=await noScript.page.goto(`${origin}/share.html`);
    assert.equal(response.status(),200);
    const links=noScript.page.locator('a[href="/"]');
    assert.ok(await links.count()>0,'The static HTML must provide a real booking-root anchor.');
    const visible=[];
    for(const link of await links.all())if(await link.isVisible())visible.push(link);
    assert.ok(visible.length>0,'The fallback link must be visible without running scripts.');
    assert.deepEqual(noScript.apiRequests,[]);
    await Promise.all([noScript.page.waitForURL(origin+'/'),visible[0].click()]);
    assert.equal(noScript.page.url(),origin+'/');
  });
  await noScript.context.close();
  await step('all surfaces honor CSP and use only local static assets and synthetic APIs',async()=>{
    assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(unexpectedApis,[]);
  });
  console.log(`${passed} browser checks passed. Screenshots: ${output}`);
}finally{
  await browser?.close();
  await new Promise(done=>server.close(done));
}
