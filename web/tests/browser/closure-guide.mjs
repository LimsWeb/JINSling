// Integration checks against the development server's synthetic accounts only.
// Start: node web/scripts/dev.mjs --port 4182
// Run with JINSLING_BROWSER_EXECUTABLE and, optionally, JINSLING_SCREENSHOT_DIR.
// Every created booking/lock is cleaned up, and the development server is kept.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {addDays,seoulToday} from '../../public/ui-utils.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const origin=new URL(process.env.JINSLING_TEST_ORIGIN||'http://127.0.0.1:4182').origin;
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname),'Only a local synthetic preview is allowed.');
const identities=await fetch(`${origin}/__preview/identities`).then(response=>response.json());
assert.equal(identities.ok,true);
assert.match(identities.data.notice,/가상/);
const accounts=identities.data.accounts;
const ownerAccount=accounts.find(account=>account.role==='admin');
const memberAccount=accounts.find(account=>account.username==='haneul_demo');
assert.ok(ownerAccount&&memberAccount,'Synthetic preview identities must be available.');
const screenshotDir=resolve(process.env.JINSLING_SCREENSHOT_DIR||join(tmpdir(),'jinsling-closure-guide'));
await mkdir(screenshotDir,{recursive:true});
const browser=await chromium.launch({headless:true,
  ...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{}),
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'],
});
const contexts=[],errors=[],externalRequests=[],results=[],batchIds=new Set(),singleIds=new Set(),bookingIds=new Set();
const runId=`browser-${Date.now()}`;
let owner,member;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const record=message=>{results.push(message);console.log(`PASS ${message}`);};
const capture=async(page,name)=>{const modal=await page.locator('#dialog[open]').count();await page.screenshot({path:join(screenshotDir,`${name}.png`),fullPage:!modal});};
function routeIs(path,method){return response=>new URL(response.url()).pathname===`/api${path}`&&response.request().method()===method;}
async function fixture(viewport={width:1440,height:1000}){
  const context=await browser.newContext({viewport,locale:'ko-KR',timezoneId:'Asia/Seoul'});contexts.push(context);
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){externalRequests.push(route.request().url());return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(10_000);
  page.on('pageerror',error=>errors.push(error.message));
  return page;
}
async function api(page,path,method='GET',body){
  const response=await page.request.fetch(`${origin}/api${path}`,{method,
    headers:{Origin:origin,'X-JinSling-Request':'1',Accept:'application/json'},
    ...(body===undefined?{}:{data:body}),
  });
  const payload=await response.json();
  assert.equal(response.status(),200,`${method} ${path}: ${JSON.stringify(payload.error||{})}`);
  assert.equal(payload.ok,true);
  return payload.data;
}
async function login(page,account){
  await page.goto(origin);
  await page.locator('.auth-card input[name="username"]').fill(account.username);
  await page.locator('.auth-card input[name="password"]').fill(account.password);
  await page.locator('.auth-card').getByRole('button',{name:'로그인',exact:true}).click();
  await page.locator('.navigation').waitFor();
}
async function settings(page){
  await page.getByRole('button',{name:'운영 설정',exact:true}).click();
  await page.getByRole('button',{name:'＋ 휴무 잠금',exact:true}).waitFor();
}
async function openClosure(page,{from,to=from,period='morning',note=''}){
  await page.getByRole('button',{name:'＋ 휴무 잠금',exact:true}).click();
  const dialog=page.locator('#dialog[open]');
  await dialog.locator('input[name="from"]').fill(from);
  await dialog.locator('input[name="to"]').fill(to);
  const label={day:'하루',morning:'오전',afternoon:'오후',custom:'직접 지정'}[period];
  await dialog.getByText(label,{exact:true}).click();
  await dialog.locator('textarea[name="note"]').fill(note);
  return dialog;
}
async function preview(page){
  const response=page.waitForResponse(routeIs('/admin/blocks/preview','POST'));
  await page.getByRole('button',{name:'잠금 내용 미리보기',exact:true}).click();
  const payload=await(await response).json();assert.equal(payload.ok,true);
  await settle(page);
  return payload.data;
}
async function save(page){
  const response=page.waitForResponse(routeIs('/admin/blocks/bulk','POST'));
  await page.getByRole('button',{name:'확인한 내용으로 잠금 저장',exact:true}).click();
  const http=await response,payload=await http.json();
  if(payload.ok)batchIds.add(payload.data.batch_id);
  await settle(page);
  return {status:http.status(),...payload};
}
async function closeDialog(page){await page.getByRole('button',{name:'창 닫기',exact:true}).click();await page.locator('#dialog[open]').waitFor({state:'hidden'});}
async function releaseGroup(page,note){
  const group=page.locator('.closure-group').filter({hasText:note});
  await group.getByRole('button',{name:'묶음 해제',exact:true}).click();
  assert.match(await page.locator('#dialog').innerText(),/따로 등록한 다른 묶음과 개별 잠금/);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith('/api/admin/block-batches/')&&r.request().method()==='DELETE');
  await page.getByRole('button',{name:'잠금 해제하기',exact:true}).click();
  assert.equal((await(await response).json()).ok,true);
  await group.waitFor({state:'hidden'});
}
async function chooseDate(page,date){
  if(!await page.locator('.calendar-day[data-date]').count())await page.getByRole('button',{name:'예약하기',exact:true}).click();
  for(let attempts=0;attempts<4&&!(await page.locator(`.calendar-day[data-date="${date}"]`).count());attempts++){
    const shown=await page.locator('.calendar-day[data-date]').first().getAttribute('data-date');
    await page.getByRole('button',{name:date.slice(0,7)<shown.slice(0,7)?'이전 달':'다음 달',exact:true}).click();
  }
  await page.locator(`.calendar-day[data-date="${date}"]`).click();
  await page.locator('.slot[data-time="09:00"]').waitFor();
  await page.waitForFunction(()=>!document.querySelector('#page-content [aria-busy="true"]'));
}
const slot=(page,time)=>page.locator(`.slot[data-time="${time}"]`);
async function assertNoOverflow(page,label){
  const sizes=await page.evaluate(()=>({width:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert.ok(sizes.document<=sizes.width&&sizes.body<=sizes.width,`${label} overflows: ${JSON.stringify(sizes)}`);
  const modal=page.locator('#dialog[open]');
  if(await modal.count())assert.equal(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth),true,`${label} dialog overflows`);
}
let from=addDays(seoulToday(),7);
while(new Date(`${from}T12:00:00Z`).getUTCDay()!==1)from=addDays(from,1);
const to=addDays(from,2);
try{
  owner=await fixture();member=await fixture();
  await login(owner,ownerAccount);await login(member,memberAccount);await settings(owner);
  assert.equal(await owner.locator('a.guide-nav-link').getAttribute('href'),'/guide.html#owner');
  assert.equal(await member.locator('a.guide-nav-link').getAttribute('href'),'/guide.html#member');
  const note=`${runId} 오전 3일`;
  await openClosure(owner,{from,to,period:'morning',note});
  let data=await preview(owner);
  assert.equal(data.count,3);assert.equal(data.start_time,'00:00');assert.equal(data.end_time,'12:00');assert.deepEqual(data.conflicts,[]);
  assert.equal(await owner.locator('.closure-confirmation').isVisible(),true);
  await owner.locator('#dialog textarea[name="note"]').fill(`${note} 수정`);
  assert.equal(await owner.locator('.closure-preview').isVisible(),false);
  assert.equal(await owner.locator('.closure-confirmation').isVisible(),false);
  await owner.locator('#dialog textarea[name="note"]').fill(note);
  await preview(owner);await capture(owner,'01-closure-preview-desktop');
  const created=await save(owner);assert.equal(created.status,200);assert.equal(created.data.items.length,3);
  assert.equal(await owner.locator('.closure-group').filter({hasText:note}).count(),1);
  record('Morning preset previews and saves three dates; editing the form invalidates confirmation.');

  await chooseDate(member,from);
  await slot(member,'09:00').locator('span.slot-status').getByText('운영자 차단',{exact:true}).waitFor();
  assert.equal(await slot(member,'09:00').isDisabled(),true);assert.equal(await slot(member,'11:30').isDisabled(),true);
  assert.equal(await slot(member,'12:00').isEnabled(),true);
  await capture(member,'02-member-half-day-availability');
  record('Member view shows morning slots blocked and the noon boundary available.');

  const single=await api(owner,'/admin/blocks','POST',{date:from,start_time:'10:30',end_time:'11:00',note:`${runId} 별도 단일 잠금`});singleIds.add(single.block.id);
  await settings(owner);await releaseGroup(owner,note);
  const remaining=await api(owner,`/admin/blocks?from=${from}&to=${to}`);
  assert.deepEqual(remaining.items.map(item=>item.id),[single.block.id]);
  await member.getByRole('button',{name:'예약하기',exact:true}).click();await chooseDate(member,from);
  await slot(member,'09:00').locator('span.slot-status').getByText('예약 가능',{exact:true}).waitFor();
  assert.equal(await slot(member,'09:00').isEnabled(),true);assert.equal(await slot(member,'10:30').isDisabled(),true);assert.equal(await slot(member,'11:00').isEnabled(),true);
  record('Releasing a group keeps its overlapping independent single lock effective.');

  const conflictDate=addDays(from,3);
  await chooseDate(member,conflictDate);await slot(member,'09:30').click();
  await member.getByRole('button',{name:'예약 내용 확인',exact:true}).click();
  const bookingResponse=member.waitForResponse(routeIs('/bookings','POST'));
  await member.getByRole('button',{name:'예약 확정하기',exact:true}).click();
  const booked=await(await bookingResponse).json();assert.equal(booked.ok,true);bookingIds.add(booked.data.booking.id);
  await openClosure(owner,{from:addDays(conflictDate,-1),to:addDays(conflictDate,1),note:`${runId} 예약 충돌`});
  data=await preview(owner);assert.deepEqual(data.conflicts,[{date:conflictDate,start_time:'09:30',end_time:'10:00'}]);
  assert.equal(await owner.locator('.closure-confirmation').isVisible(),false);
  assert.match(await owner.locator('.closure-conflicts').innerText(),/09:30–10:00/);
  assert.doesNotMatch(await owner.locator('.closure-preview').innerText(),new RegExp(memberAccount.name));
  assert.equal((await api(owner,`/admin/blocks?from=${addDays(conflictDate,-1)}&to=${addDays(conflictDate,1)}`)).items.length,0);
  await capture(owner,'03-conflict-preview');await closeDialog(owner);
  record('Existing booking conflicts expose only dates/times and prevent the entire group from being saved.');

  const raceFrom=addDays(from,7),raceTo=addDays(from,9);
  await openClosure(owner,{from:raceFrom,to:raceTo,note:`${runId} 예약 경쟁`});await preview(owner);
  const racing=await api(member,'/bookings','POST',{date:raceTo,start_time:'09:00',memo:'합성 데이터 경쟁 검사',request_id:crypto.randomUUID()});bookingIds.add(racing.booking.id);
  const rejected=await save(owner);assert.equal(rejected.status,409);assert.equal(rejected.ok,false);
  assert.equal(await owner.locator('.closure-confirmation').isVisible(),false);
  assert.match(await owner.locator('.closure-status').innerText(),/다시 미리보기/);
  assert.equal((await api(owner,`/admin/blocks?from=${raceFrom}&to=${raceTo}`)).items.length,0);
  const untouched=(await api(owner,`/bookings?from=${raceTo}&to=${raceTo}`)).items.find(item=>item.id===racing.booking.id);assert.equal(untouched.status,'confirmed');
  await closeDialog(owner);
  record('A booking after preview causes a 409, clears confirmation, preserves that booking and leaves zero partial locks.');

  const retryNote=`${runId} 응답 유실 재시도`,retryBodies=[];
  await openClosure(owner,{from,to:addDays(from,1),period:'afternoon',note:retryNote});await preview(owner);
  const retryHandler=async route=>{
    retryBodies.push(route.request().postDataJSON());
    const response=await route.fetch(),payload=await response.json();
    assert.equal(payload.ok,true);batchIds.add(payload.data.batch_id);
    if(retryBodies.length===1)return route.abort('failed');
    return route.fulfill({response});
  };
  await owner.route('**/api/admin/blocks/bulk',retryHandler);
  await owner.getByRole('button',{name:'확인한 내용으로 잠금 저장',exact:true}).click();
  await owner.locator('.closure-status').getByText(/같은 요청 번호/).waitFor();
  const retried=await save(owner);assert.equal(retried.status,200);assert.equal(retryBodies.length,2);
  assert.deepEqual(retryBodies[0],retryBodies[1]);assert.match(retryBodies[0].request_id,/^[0-9a-f-]{36}$/);
  assert.equal((await api(owner,`/admin/blocks?from=${from}&to=${addDays(from,1)}`)).items.filter(item=>item.batch_id===retried.data.batch_id).length,2);
  await owner.unroute('**/api/admin/blocks/bulk',retryHandler);await releaseGroup(owner,retryNote);
  record('A lost response retries with the identical UUID and payload; only one two-day group exists.');

  const pendingPreview=deferred();
  const holdPreview=async route=>pendingPreview.resolve({route,response:await route.fetch()});
  await owner.route('**/api/admin/blocks/preview',holdPreview);
  await openClosure(owner,{from,to,period:'afternoon',note:`${runId} 지연 미리보기`});
  await owner.getByRole('button',{name:'잠금 내용 미리보기',exact:true}).click();
  let held=await pendingPreview.promise;
  await owner.locator('#dialog textarea[name="note"]').fill('응답을 기다리는 동안 수정한 메모');
  const delayed=owner.waitForResponse(routeIs('/admin/blocks/preview','POST'));
  await held.route.fulfill({response:held.response});await(await delayed).finished();await settle(owner);
  assert.equal(await owner.locator('.closure-preview').isVisible(),false);assert.equal(await owner.locator('.closure-confirmation').isVisible(),false);
  await owner.unroute('**/api/admin/blocks/preview',holdPreview);await closeDialog(owner);
  record('A late preview response cannot re-enable confirmation after an input changes.');

  const pendingSave=deferred(),lateNote=`${runId} 지연 저장`;
  const holdSave=async route=>{
    const response=await route.fetch(),payload=await response.json();assert.equal(payload.ok,true);batchIds.add(payload.data.batch_id);
    pendingSave.resolve({route,response});
  };
  await owner.route('**/api/admin/blocks/bulk',holdSave);
  await openClosure(owner,{from,to:from,period:'afternoon',note:lateNote});await preview(owner);
  await owner.getByRole('button',{name:'확인한 내용으로 잠금 저장',exact:true}).click();held=await pendingSave.promise;
  await closeDialog(owner);await openClosure(owner,{from:to,to,period:'custom',note:'새 창의 입력을 지켜 주세요'});
  const lateResponse=owner.waitForResponse(routeIs('/admin/blocks/bulk','POST'));
  await held.route.fulfill({response:held.response});await(await lateResponse).finished();await settle(owner);
  assert.equal(await owner.locator('#dialog[open]').count(),1);assert.equal(await owner.locator('#dialog textarea[name="note"]').inputValue(),'새 창의 입력을 지켜 주세요');
  assert.equal(await owner.locator('#dialog input[name="from"]').inputValue(),to);
  await owner.unroute('**/api/admin/blocks/bulk',holdSave);await closeDialog(owner);await settings(owner);await releaseGroup(owner,lateNote);
  record('A delayed successful save cannot close or overwrite a newly opened closure dialog.');

  await owner.setViewportSize({width:390,height:844});
  await openClosure(owner,{from,to,period:'custom',note:'휴무 안내 · 모바일 입력 확인'});
  await owner.locator('#dialog select[name="start_time"]').selectOption('23:30');
  await owner.locator('#dialog select[name="end_time"]').selectOption('24:00');
  data=await preview(owner);assert.equal(data.end_time,'24:00');await assertNoOverflow(owner,'390px closure');await capture(owner,'04-closure-mobile-390');await closeDialog(owner);
  record('390px closure form fits without horizontal overflow and previews a custom 24:00 end time.');

  const guardPage=await fixture(),accountPreview=deferred();
  await login(guardPage,ownerAccount);await settings(guardPage);
  const accountHandler=async route=>accountPreview.resolve({route,response:await route.fetch()});
  await guardPage.route('**/api/admin/blocks/preview',accountHandler);
  await openClosure(guardPage,{from,to,period:'afternoon',note:'계정 변경 뒤 숨겨야 할 관리자 메모'});
  await guardPage.getByRole('button',{name:'잠금 내용 미리보기',exact:true}).click();held=await accountPreview.promise;
  await api(guardPage,'/auth/login','POST',{username:memberAccount.username,password:memberAccount.password});
  const changedSession=guardPage.waitForResponse(routeIs('/session','GET'));
  await guardPage.evaluate(()=>window.dispatchEvent(new Event('focus')));await(await changedSession).finished();
  await guardPage.locator('#dialog[open]').waitFor({state:'hidden'});
  const accountResponse=guardPage.waitForResponse(routeIs('/admin/blocks/preview','POST'));
  await held.route.fulfill({response:held.response});await(await accountResponse).finished();await settle(guardPage);
  assert.equal(await guardPage.getByRole('button',{name:'운영 설정',exact:true}).count(),0);
  assert.equal(await guardPage.locator('.closure-form').count(),0);
  assert.doesNotMatch(await guardPage.locator('body').innerText(),/계정 변경 뒤 숨겨야 할 관리자 메모/);
  assert.equal(await guardPage.locator('a.guide-nav-link').getAttribute('href'),'/guide.html#member');
  await guardPage.unroute('**/api/admin/blocks/preview',accountHandler);
  record('An observed account change closes the owner dialog; a late preview cannot restore its contents.');

  const guide=await fixture({width:390,height:844}),guideApi=[];
  guide.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))guideApi.push(request.url());});
  await guide.goto(`${origin}/guide.html#member`);await guide.locator('#guide-search:enabled').waitFor();
  assert.equal(await guide.locator('#member').isVisible(),true);assert.equal(await guide.locator('#owner').isVisible(),false);
  assert.equal(await guide.locator('#member .guide-topic:visible').count(),6);await assertNoOverflow(guide,'390px member guide');await capture(guide,'05-member-guide-mobile-390');
  await guide.getByRole('link',{name:'사장님 안내',exact:true}).click();
  assert.equal(await guide.locator('#owner').isVisible(),true);assert.equal(await guide.locator('#member').isVisible(),false);
  assert.equal(await guide.locator('#owner .guide-topic:visible').count(),9);
  await guide.locator('#guide-search').fill('휴무 잠금');
  assert.ok(await guide.locator('#owner .guide-topic:visible').count()>0);
  assert.equal(await guide.locator('#owner-closures').isVisible(),true);assert.match(await guide.locator('#guide-results').innerText(),/찾았어요/);
  await assertNoOverflow(guide,'390px searched owner guide');await capture(guide,'06-owner-guide-search-mobile-390');
  await guide.locator('#guide-search').fill('없는검색어123');assert.equal(await guide.locator('#guide-empty').isVisible(),true);
  await guide.locator('#guide-search').fill('QR');assert.equal(await guide.locator('#owner-share').isVisible(),true);
  await guide.emulateMedia({media:'print'});
  assert.equal(await guide.locator('#owner .guide-topic:visible').count(),9,'Print includes the whole selected guide even during search.');
  assert.equal(await guide.locator('#member').isVisible(),false);await guide.emulateMedia({media:'screen'});
  await guide.locator('#guide-search').fill('');await guide.setViewportSize({width:1440,height:1000});await capture(guide,'07-owner-guide-desktop');
  assert.deepEqual(guideApi,[]);assert.doesNotMatch(await guide.locator('body').innerText(),new RegExp(ownerAccount.username));
  record('Public guide switches roles, searches, handles zero results, fits 390px and prints all selected-role topics without any API request.');

  const loggedOut=await fixture({width:390,height:844});await loggedOut.goto(origin);
  await loggedOut.locator('.auth-guide a').waitFor();assert.equal(await loggedOut.locator('.auth-guide a').getAttribute('href'),'/guide.html#member');
  record('Owner, member and logged-out screens link to the correct public guide section.');
  assert.deepEqual(errors,[],'Browser runtime errors');assert.deepEqual(externalRequests,[],'Unexpected external requests');
  await writeFile(join(screenshotDir,'results.json'),JSON.stringify({origin,from,to,passed:results.length,results,screenshots:screenshotDir,errors,externalRequests},null,2)+'\n');
  console.log(`Completed ${results.length} browser scenarios; screenshots: ${screenshotDir}`);
}finally{
  if(owner){
    // Restore the owner identity before fixture cleanup if a guard test changed it.
    await api(owner,'/auth/login','POST',{username:ownerAccount.username,password:ownerAccount.password}).catch(()=>{});
    for(const id of batchIds)await api(owner,`/admin/block-batches/${encodeURIComponent(id)}`,'DELETE',{}).catch(error=>console.error(`Cleanup group failed: ${error.message}`));
    for(const id of singleIds)await api(owner,`/admin/blocks/${encodeURIComponent(id)}`,'DELETE',{}).catch(error=>console.error(`Cleanup single failed: ${error.message}`));
    for(const id of bookingIds)await api(owner,`/bookings/${encodeURIComponent(id)}/cancel`,'POST',{version:1,reason:'합성 브라우저 검사 정리'}).catch(error=>console.error(`Cleanup booking failed: ${error.message}`));
  }
  for(const context of contexts)await context.close();
  await browser.close();
}
