// Optional real-browser regression. Run against a fresh synthetic dev preview.
// JINSLING_TEST_ORIGIN=http://127.0.0.1:4176
// JINSLING_BROWSER_EXECUTABLE=/path/to/chromium node web/tests/browser/calendar-sharing.mjs
// Install Playwright in the environment, or set CODEX_PRIMARY_RUNTIME_NODE_MODULES.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {addDays,seoulToday} from '../../public/ui-utils.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const origin=new URL(process.env.JINSLING_TEST_ORIGIN||'http://127.0.0.1:4176').origin;
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname),
  'This script is restricted to a local preview with fictional accounts.');
const output=process.env.JINSLING_BROWSER_OUTPUT||join(tmpdir(),'jinsling-calendar-browser');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({
  ...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{}),
  headless:true,args:['--disable-dev-shm-usage'],
});
const errors=[],externalRequests=[],contexts=[],createdBookings=new Map(),createdBlocks=new Set();
async function context(){
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',timezoneId:'Asia/Seoul',acceptDownloads:true});
  await ctx.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){externalRequests.push(route.request().url().split('#')[0]);return route.abort();}
    return route.continue();
  });
  ctx.on('page',page=>{
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to/.test(message.text()))errors.push(message.text());});
  });
  contexts.push(ctx);return ctx;
}
const ownerContext=await context(),aliceContext=await context(),bobContext=await context();
async function request(ctx,path,body,method='POST'){
  const response=await ctx.request.fetch(origin+'/api'+path,{
    method,...(body===undefined?{}:{data:body}),headers:{Origin:origin,'X-JinSling-Request':'1'},
  });
  return {status:response.status(),payload:await response.json()};
}
async function api(ctx,path,body,method='POST'){
  const {status,payload}=await request(ctx,path,body,method);
  assert.equal(payload.ok,true,`${method} ${path.split('?')[0]}: ${status} ${payload.error?.code||''}`);
  return payload.data;
}
async function book(ctx,body){
  const booking=(await api(ctx,'/bookings',body)).booking;
  createdBookings.set(booking.id,booking);return booking;
}
async function cancel(booking){
  await api(ownerContext,`/bookings/${booking.id}/cancel`,{version:booking.version,reason:'가상 테스트 정리'});
  createdBookings.delete(booking.id);
}
async function step(label,action){await action();console.log('PASS '+label);}
async function focus(page){await page.bringToFront();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));}
async function reserve(page){
  if(!(await page.getByRole('heading',{name:'예약하기',exact:true}).count()))await page.getByRole('button',{name:/예약하기/}).click();
  await page.locator('.calendar-day[data-date]').first().waitFor();
}
async function selectDate(page,date){
  await reserve(page);
  for(let i=0;i<4&&!(await page.locator(`.calendar-day[data-date="${date}"]`).count());i++){
    const displayed=await page.locator('.calendar-day[data-date]').first().getAttribute('data-date');
    await page.getByRole('button',{name:date.slice(0,7)<displayed.slice(0,7)?'이전 달':'다음 달',exact:true}).click();
    await page.locator('.calendar-day[data-date]').first().waitFor();
  }
  await page.locator(`.calendar-day[data-date="${date}"]`).click();
  await page.locator('.slots-section .slot[data-time]').first().waitFor();
}
const slot=(page,time)=>page.locator(`.slot[data-time="${time}"]`);
async function assertNoPrivateAvailability(ctx,date,privateValues){
  const day=await api(ctx,'/availability?date='+date,undefined,'GET');
  const month=await api(ctx,'/availability/calendar?month='+date.slice(0,7),undefined,'GET');
  const encoded=JSON.stringify({day,month});
  for(const value of privateValues)assert.ok(!encoded.includes(value),'Availability must not expose private account/booking data.');
  for(const key of ['customer_name','phone','memo','user_id','updated_by','id']){
    assert.ok(!new RegExp('"'+key+'"\\s*:').test(encoded),'Availability must contain no private field '+key);
  }
  return {day,month};
}
const owner=await ownerContext.newPage(),alice=await aliceContext.newPage(),bob=await bobContext.newPage();
for(const page of [owner,alice,bob])await page.clock.install();
let date=addDays(seoulToday(),5);
if(new Date(date+'T12:00:00Z').getUTCDay()===0)date=addDays(date,1);
let otherDate=addDays(date,7);
const memo='가상 데이터 · 갱신 뒤에도 남아야 하는 메모';
const privateName='비공개 가상 고객',privatePhone='01000000077',privateMemo='표시하면 안 되는 테스트 예약 메모';
try{
  const identities=await(await ownerContext.request.get(origin+'/__preview/identities')).json();
  assert.match(identities.data.notice,/가상 데이터/);
  for(const [ctx,username] of [[ownerContext,'owner_demo'],[aliceContext,'haneul_demo'],[bobContext,'seojun_demo']]){
    const account=identities.data.accounts.find(value=>value.username===username);
    assert.ok(account,'Use a freshly seeded preview.');
    await api(ctx,'/auth/login',{username:account.username,password:account.password});
  }
  await Promise.all([owner.goto(origin),alice.goto(origin),bob.goto(origin)]);
  await selectDate(alice,date);await selectDate(bob,date);
  const initial=await api(aliceContext,'/availability?date='+date,undefined,'GET');
  const chosen=initial.slots.find(value=>value.available&&value.start_time==='11:00')||initial.slots.find(value=>value.available);
  assert.ok(chosen,'Choose a fresh preview with a free test slot.');
  const time=chosen.start_time;
  let occupied;
  await step('open member calendar refreshes global occupied slot while preserving memo and focus',async()=>{
    await slot(alice,time).click();
    await alice.locator('textarea[name="memo"]').fill(memo);
    await alice.locator('textarea[name="memo"]').focus();
    occupied=await book(ownerContext,{date,start_time:time,customer_name:privateName,phone:privatePhone,memo:privateMemo});
    await focus(alice);
    await alice.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    assert.match(await slot(alice,time).innerText(),/예약됨/);
    assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
    assert.equal(await alice.evaluate(()=>document.activeElement?.getAttribute('name')),'memo');
    assert.equal(await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).isDisabled(),true);
    assert.match(await alice.locator(`.calendar-day[data-date="${date}"]`).innerText(),/예약/);
    assert.ok(!(await alice.locator('#page-content').innerText()).includes(privateName));
    await focus(bob);await bob.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    const {day,month}=await assertNoPrivateAvailability(bobContext,date,[privateName,privatePhone,privateMemo,occupied.id]);
    assert.equal(day.slots.find(value=>value.start_time===time).status,'booked');
    assert.equal(month.days.find(value=>value.date===date).booked_count,day.booked_count);
    await alice.screenshot({path:join(output,'calendar-occupied-desktop.png'),fullPage:true});
  });
  await step('exact date/time duplicate is rejected; another date remains independently bookable',async()=>{
    const duplicate=await request(bobContext,'/bookings',{date,start_time:time,memo:'동일 시간 경쟁 테스트'});
    assert.equal(duplicate.status,409);assert.equal(duplicate.payload.error.code,'conflict');
    const independent=await api(bobContext,'/availability?date='+otherDate,undefined,'GET');
    assert.equal(independent.slots.find(value=>value.start_time===time).available,true);
    const other=await book(bobContext,{date:otherDate,start_time:time,memo:'다른 날짜 테스트'});
    const all=(await api(ownerContext,`/bookings?from=${date}&to=${otherDate}`,undefined,'GET')).items;
    assert.equal(all.filter(value=>value.date===date&&value.start_time===time&&value.status==='confirmed').length,1);
    assert.equal(all.filter(value=>value.date===otherDate&&value.start_time===time&&value.status==='confirmed').length,1);
    await selectDate(bob,otherDate);await bob.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    await cancel(other);
  });
  await step('cancelling a booking reopens the slot on the 30-second calendar refresh',async()=>{
    await cancel(occupied);
    await alice.bringToFront();await alice.clock.runFor(31_000);
    await alice.locator(`.slot[data-time="${time}"]:enabled`).waitFor();
    assert.match(await slot(alice,time).innerText(),/예약 가능/);
    assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
  });
  await step('failed availability refresh disables stale choices and recovery preserves the draft',async()=>{
    await slot(alice,time).click();
    assert.equal(await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).isEnabled(),true);
    await alice.route('**/api/availability/calendar**',route=>route.abort('failed'));
    await focus(alice);await alice.locator('.sync-error').waitFor();
    assert.equal(await alice.locator('.slot:enabled').count(),0);
    assert.equal(await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).isDisabled(),true);
    assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
    await alice.unroute('**/api/availability/calendar**');await focus(alice);
    await alice.locator(`.slot[data-time="${time}"]:enabled`).waitFor();
    await alice.locator('.sync-error').waitFor({state:'detached'});
    assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
  });
  await step('owner blocks disable the shared slot without exposing block notes',async()=>{
    const block=(await api(ownerContext,'/admin/blocks',{date,start_time:time,end_time:chosen.end_time,note:'비공개 운영자 차단 메모'})).block;
    createdBlocks.add(block.id);
    await focus(alice);await alice.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    assert.match(await slot(alice,time).innerText(),/차단/);
    await assertNoPrivateAvailability(aliceContext,date,['비공개 운영자 차단 메모',block.id]);
    await api(ownerContext,'/admin/blocks/'+block.id,{},'DELETE');createdBlocks.delete(block.id);
    await focus(alice);await alice.locator(`.slot[data-time="${time}"]:enabled`).waitFor();
  });
  await step('stale confirmation receives conflict and returns to updated choices with memo intact',async()=>{
    await slot(alice,time).click();
    await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).click();
    occupied=await book(ownerContext,{date,start_time:time,customer_name:privateName,phone:privatePhone});
    await alice.locator('#dialog').getByRole('button',{name:'예약 확정하기',exact:true}).click();
    await alice.locator('#dialog').getByRole('button',{name:'다른 시간 선택',exact:true}).waitFor();
    await alice.locator('#dialog').getByRole('button',{name:'다른 시간 선택',exact:true}).click();
    await alice.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    assert.equal(await alice.locator('#dialog').evaluate(node=>node.open),false);
    assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
    assert.equal(await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).isDisabled(),true);
    const all=(await api(ownerContext,`/bookings?from=${date}&to=${date}`,undefined,'GET')).items;
    assert.equal(all.filter(value=>value.start_time===time&&value.status==='confirmed').length,1);
  });
  if(await alice.getByRole('button',{name:'다음 달',exact:true}).isEnabled()){
    await step('moving to another month aligns selected day, slot heading and summary date',async()=>{
      const current=await alice.locator('.calendar-day.selected').getAttribute('data-date');
      const next=new Date(`${current.slice(0,7)}-01T12:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
      const expectedDate=next.toISOString().slice(0,10);
      // Closing the prior dialog can still have a read in flight. Wait for the
      // requested new month, rather than accepting that unrelated response.
      const monthResponse=alice.waitForResponse(response=>{
        const url=new URL(response.url());
        return url.pathname==='/api/availability'&&url.searchParams.get('date')===expectedDate;
      });
      await alice.getByRole('button',{name:'다음 달',exact:true}).click();
      const response=await monthResponse;
      const requested=new URL(response.url()).searchParams.get('date');
      const selected=alice.locator('.calendar-day.selected');
      assert.equal(await selected.getAttribute('data-date'),requested);
      assert.notEqual(requested.slice(0,7),date.slice(0,7));
      await alice.locator('.selected-slot-date').waitFor();
      assert.equal(await alice.locator('.summary-date').innerText(),await alice.locator('.selected-slot-date').innerText());
      assert.equal(await alice.getByRole('button',{name:'예약 내용 확인',exact:true}).isDisabled(),true);
      assert.equal(await alice.locator('textarea[name="memo"]').inputValue(),memo);
      await selectDate(alice,date);
    });
  }else console.log('SKIP month navigation: configured booking window ends in the current month.');
  await step('QR URL and image open the same address; failed automatic copy leaves selectable text',async()=>{
    await owner.getByRole('button',{name:/회원 관리/}).click();
    await owner.getByRole('button',{name:'예약 안내 · QR',exact:true}).click();
    await owner.locator('#dialog canvas').waitFor();
    const anchor=owner.locator('#dialog a.share-link-anchor'),preview=owner.locator('#dialog a.share-card-preview');
    assert.equal(await anchor.getAttribute('href'),origin+'/');
    assert.equal(await preview.getAttribute('href'),origin+'/');
    for(const link of [anchor,preview]){
      assert.equal(await link.getAttribute('target'),'_blank');
      assert.match(await link.getAttribute('rel'),/noopener/);
      const popupPromise=ownerContext.waitForEvent('page');await link.click();
      const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');
      assert.equal(new URL(popup.url()).origin,origin);
      assert.equal(await popup.evaluate(()=>window.opener===null),true);await popup.close();
    }
    await owner.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
      document.execCommand=()=>false;
    });
    await owner.getByRole('button',{name:'링크 복사',exact:true}).click();
    const selected=await owner.locator('#dialog textarea.share-url').evaluate(node=>({value:node.value,start:node.selectionStart,end:node.selectionEnd,focused:document.activeElement===node,readonly:node.readOnly}));
    assert.deepEqual(selected,{value:origin+'/',start:0,end:(origin+'/').length,focused:true,readonly:true});
    const downloadPromise=owner.waitForEvent('download');await owner.getByRole('button',{name:'이미지 저장 (PNG)',exact:true}).click();
    await(await downloadPromise).saveAs(join(output,'public-qr.png'));
    await owner.setViewportSize({width:390,height:844});
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await owner.screenshot({path:join(output,'qr-clickable-mobile.png'),fullPage:true});
    await owner.getByRole('button',{name:'창 닫기',exact:true}).click();
    await owner.getByRole('button',{name:'＋ 1회용 초대',exact:true}).click();
    await owner.locator('#dialog canvas').waitFor();
    const invite=await owner.locator('#dialog textarea.share-url').inputValue();
    assert.match(invite,/#invite=.+/);
    assert.equal(await owner.locator('#dialog a.share-link-anchor').getAttribute('href'),invite);
    assert.equal(await owner.locator('#dialog a.share-card-preview').getAttribute('href'),invite);
    await owner.getByRole('button',{name:'링크 복사',exact:true}).click();
    assert.equal(await owner.locator('#dialog textarea.share-url').evaluate(node=>node.value.slice(node.selectionStart,node.selectionEnd)),invite);
    await owner.getByRole('button',{name:'보관했어요',exact:true}).click();
  });
  await step('mobile calendar and explicit occupied labels fit a 390px viewport',async()=>{
    await alice.setViewportSize({width:390,height:844});await focus(alice);
    await alice.locator(`.slot[data-time="${time}"]:disabled`).waitFor();
    assert.equal(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await alice.screenshot({path:join(output,'calendar-occupied-mobile.png'),fullPage:true});
  });
  assert.deepEqual(errors,[],'No browser runtime/CSP errors.');
  assert.deepEqual(externalRequests,[],'No QR or customer data sent to external services.');
  console.log('PASS no runtime/CSP errors or external requests; screenshots contain synthetic data only.');
}finally{
  for(const booking of createdBookings.values()){
    try{await api(ownerContext,`/bookings/${booking.id}/cancel`,{version:booking.version,reason:'가상 테스트 정리'});}catch{}
  }
  for(const id of createdBlocks){try{await api(ownerContext,'/admin/blocks/'+id,{},'DELETE');}catch{}}
  for(const ctx of contexts)await ctx.close();
  await browser.close();
}
