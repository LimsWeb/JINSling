// Real browser checks on synthetic local accounts. No production credentials.
// Start the development server, then set JINSLING_TEST_ORIGIN and
// JINSLING_BROWSER_EXECUTABLE when Chromium is supplied by the runtime.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {addDays,seoulToday} from '../../public/ui-utils.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ?join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright'):'playwright');
const origin=new URL(process.env.JINSLING_TEST_ORIGIN||'http://127.0.0.1:4182').origin;
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname));
const identities=await fetch(`${origin}/__preview/identities`).then(r=>r.json());
assert.equal(identities.ok,true);assert.match(identities.data.notice,/가상/);
const ownerAccount=identities.data.accounts.find(a=>a.role==='admin');
const memberAccount=identities.data.accounts.find(a=>a.username==='haneul_demo');
const browser=await chromium.launch({headless:true,
  ...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{}),
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const screenshotDir=resolve(process.env.JINSLING_SCREENSHOT_DIR||join(tmpdir(),'jinsling-recurring'));
await mkdir(screenshotDir,{recursive:true});
const contexts=[],results=[],errors=[],externalRequests=[],ruleIds=new Set(),bookingIds=new Set(),blockIds=new Set();
const runId=`recurring-browser-${Date.now()}`;
let owner,member;
let from=addDays(seoulToday(),7);
while(new Date(`${from}T12:00:00Z`).getUTCDay()!==1)from=addDays(from,1);
const record=text=>{results.push(text);console.log(`PASS ${text}`);};
const settle=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const routeIs=(path,method)=>r=>new URL(r.url()).pathname===`/api${path}`&&r.request().method()===method;
const slot=(page,time)=>page.locator(`.slot[data-time="${time}"]`);
const card=(page,id)=>page.locator(`.recurring-rule[data-rule-id="${id}"]`);
async function fixture(){
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ko-KR',timezoneId:'Asia/Seoul'});contexts.push(context);
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){externalRequests.push(route.request().url());return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));return page;
}
async function request(page,path,method='GET',body){
  const http=await page.request.fetch(`${origin}/api${path}`,{method,
    headers:{Origin:origin,'X-JinSling-Request':'1',Accept:'application/json'},...(body===undefined?{}:{data:body})});
  const payload=await http.json();return {status:http.status(),...payload};
}
async function api(page,path,method='GET',body){const r=await request(page,path,method,body);assert.equal(r.status,200,`${method} ${path}: ${JSON.stringify(r)}`);assert.equal(r.ok,true);return r.data;}
async function login(page,account){
  await page.goto(origin);await page.locator('.auth-card input[name="username"]').fill(account.username);
  await page.locator('.auth-card input[name="password"]').fill(account.password);
  await page.locator('.auth-card').getByRole('button',{name:'로그인',exact:true}).click();await page.locator('.navigation').waitFor();
}
async function settings(page){await page.getByRole('button',{name:'운영 설정',exact:true}).click();await page.getByRole('button',{name:'점심시간 설정',exact:true}).waitFor();}
async function preview(page){
  const response=page.waitForResponse(routeIs('/admin/recurring-blocks/preview','POST'));
  await page.getByRole('button',{name:'반복 일정 미리보기',exact:true}).click();
  const payload=await(await response).json();assert.equal(payload.ok,true,JSON.stringify(payload));await settle(page);return payload.data;
}
async function save(page,id){
  const response=page.waitForResponse(routeIs(`/admin/recurring-blocks${id?`/${id}`:''}`,id?'PUT':'POST'));
  await page.getByRole('button',{name:'확인한 반복 잠금 저장',exact:true}).click();
  const http=await response,payload=await http.json();if(payload.ok)ruleIds.add(payload.data.rule.id);await settle(page);return {status:http.status(),...payload};
}
async function closeDialog(page){await page.getByRole('button',{name:'창 닫기',exact:true}).click();await page.locator('#dialog[open]').waitFor({state:'hidden'});}
async function chooseDate(page,date){
  await page.getByRole('button',{name:'예약하기',exact:true}).click();
  for(let attempt=0;attempt<4&&!await page.locator(`.calendar-day[data-date="${date}"]`).count();attempt++){
    const shown=await page.locator('.calendar-day[data-date]').first().getAttribute('data-date');
    await page.getByRole('button',{name:date.slice(0,7)<shown.slice(0,7)?'이전 달':'다음 달',exact:true}).click();
  }
  await page.locator(`.calendar-day[data-date="${date}"]`).click();await slot(page,'13:00').waitFor();
  await page.waitForFunction(()=>!document.querySelector('#page-content [aria-busy="true"]'));
}
async function noOverflow(page,label){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${label}: page overflow`);
  const dialog=page.locator('#dialog[open]');if(await dialog.count())assert.equal(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth),true,`${label}: dialog overflow`);
}
async function capture(page,name){await page.screenshot({path:join(screenshotDir,`${name}.png`),fullPage:!(await page.locator('#dialog[open]').count())});}
async function confirmAction(page,{id,action,confirm,method='PATCH',suffix='',status=200}){
  await card(page,id).getByRole('button',{name:action,exact:typeof action==='string'}).click();
  const response=page.waitForResponse(routeIs(`/admin/recurring-blocks/${id}${suffix}`,method));
  await page.locator('#dialog[open]').getByRole('button',{name:confirm,exact:true}).click();
  const http=await response,payload=await http.json();assert.equal(http.status(),status,JSON.stringify(payload));await settle(page);
  if(status===200)await page.locator('#dialog[open]').waitFor({state:'hidden'});return payload;
}
async function recurrenceList(page){return (await api(page,'/admin/recurring-blocks')).items;}
async function openAdd(page){await page.getByRole('button',{name:'＋ 반복 잠금',exact:true}).click();return page.locator('#dialog[open]');}
async function setWeekdays(dialog,selected){for(const day of [0,1,2,3,4,5,6]){
  const input=dialog.locator(`[name="weekdays"][value="${day}"]`);
  if(await input.isChecked()!==selected.includes(day))await input.locator('..').click();
  assert.equal(await input.isChecked(),selected.includes(day));
}}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
try{
  owner=await fixture();member=await fixture();await login(owner,ownerAccount);await login(member,memberAccount);await settings(owner);
  await owner.getByRole('button',{name:'점심시간 설정',exact:true}).click();
  let dialog=owner.locator('#dialog[open]');
  assert.equal(await dialog.locator('[name="frequency"]').inputValue(),'weekly');
  assert.deepEqual(await dialog.locator('[name="weekdays"]:checked').evaluateAll(nodes=>nodes.map(n=>Number(n.value)).sort()),[1,2,3,4,5,6]);
  assert.equal(await dialog.locator('[name="start_time"]').inputValue(),'13:00');
  assert.equal(await dialog.locator('[name="end_time"]').inputValue(),'14:00');
  await dialog.locator('[name="start_date"]').fill(from);await dialog.locator('[name="note"]').fill(`${runId} 점심`);
  let data=await preview(owner);assert.equal(data.can_save,true);assert.deepEqual(data.conflicts,[]);assert.equal(data.occurrences[0].date,from);
  await dialog.locator('[name="note"]').fill(`${runId} 점심 수정`);
  assert.equal(await dialog.locator('.recurring-preview').isVisible(),false);
  await dialog.locator('[name="note"]').fill(`${runId} 점심`);await preview(owner);await capture(owner,'01-lunch-preview');
  const created=await save(owner);assert.equal(created.status,200);const lunch=created.data.rule;
  await card(owner,lunch.id).waitFor();record('Lunch preset saves Mon–Sat 13:00–14:00; changed input invalidates preview.');

  await chooseDate(member,from);
  assert.equal(await slot(member,'13:00').isDisabled(),true);assert.equal(await slot(member,'13:30').isDisabled(),true);
  assert.equal(await slot(member,'12:30').isEnabled(),true);assert.equal(await slot(member,'14:00').isEnabled(),true);
  const daily=await api(member,`/availability?date=${from}`),calendar=await api(member,`/availability/calendar?month=${from.slice(0,7)}`);
  assert.equal(calendar.days.find(d=>d.date===from).available_count,daily.available_count);
  assert.doesNotMatch(JSON.stringify(daily),/recurring-browser|customer_name|phone|rule_id|note/);
  await capture(member,'02-member-lunch-blocked');record('Members see shared lunch blocking with open half-hour boundaries; day/calendar totals agree and disclose no notes.');

  const independent=await api(owner,'/admin/blocks','POST',{date:from,start_time:'13:30',end_time:'14:00',note:`${runId} 개별 잠금`});blockIds.add(independent.block.id);
  await card(owner,lunch.id).getByRole('button',{name:'하루만 열기',exact:true}).click();
  await owner.locator('#dialog [name="exception_date"]').fill(from);
  let response=owner.waitForResponse(routeIs(`/admin/recurring-blocks/${lunch.id}/exceptions/${from}`,'PUT'));
  await owner.getByRole('button',{name:'이 날짜만 열기',exact:true}).click();assert.equal((await(await response).json()).ok,true);
  await owner.locator('#dialog[open]').waitFor({state:'hidden'});await card(owner,lunch.id).locator('.recurring-exceptions').waitFor();
  await chooseDate(member,from);assert.equal(await slot(member,'13:00').isEnabled(),true);assert.equal(await slot(member,'13:30').isDisabled(),true);
  await chooseDate(member,addDays(from,1));assert.equal(await slot(member,'13:00').isDisabled(),true);
  await capture(owner,'03-one-date-exception');record('One-date opening leaves other dates and an overlapping independent lock unchanged.');

  const reserved=await api(member,'/bookings','POST',{date:from,start_time:'13:00',memo:'예외 복원 충돌 확인',request_id:crypto.randomUUID()});bookingIds.add(reserved.booking.id);
  await card(owner,lunch.id).locator('summary').click();
  let rejected=await confirmAction(owner,{id:lunch.id,action:/다시 잠그기$/,confirm:'예외 해제하기',method:'DELETE',suffix:`/exceptions/${from}`,status:409});
  assert.equal(rejected.ok,false);assert.match(await owner.locator('#dialog').innerText(),/예약|겹/);await closeDialog(owner);
  assert.deepEqual((await recurrenceList(owner)).find(r=>r.id===lunch.id).exceptions,[from]);
  await api(owner,`/bookings/${reserved.booking.id}/cancel`,'POST',{version:reserved.booking.version,reason:'합성 테스트 취소'});
  await confirmAction(owner,{id:lunch.id,action:/다시 잠그기$/,confirm:'예외 해제하기',method:'DELETE',suffix:`/exceptions/${from}`});
  await chooseDate(member,from);assert.equal(await slot(member,'13:00').isDisabled(),true);
  await api(owner,`/admin/blocks/${independent.block.id}`,'DELETE',{});blockIds.delete(independent.block.id);
  record('Restoring an exception rejects an intervening booking; after cancellation the same date is blocked again.');

  await confirmAction(owner,{id:lunch.id,action:'일시중지',confirm:'일시중지하기'});
  await card(owner,lunch.id).getByRole('button',{name:'재개',exact:true}).waitFor();
  await chooseDate(member,from);assert.equal(await slot(member,'13:00').isEnabled(),true);
  const duringPause=await api(member,'/bookings','POST',{date:from,start_time:'13:00',memo:'일시중지 충돌 확인',request_id:crypto.randomUUID()});bookingIds.add(duringPause.booking.id);
  await confirmAction(owner,{id:lunch.id,action:'재개',confirm:'다시 적용하기',status:409});await closeDialog(owner);
  assert.equal((await recurrenceList(owner)).find(r=>r.id===lunch.id).enabled,false);
  await api(owner,`/bookings/${duringPause.booking.id}/cancel`,'POST',{version:duringPause.booking.version,reason:'합성 테스트 취소'});
  await confirmAction(owner,{id:lunch.id,action:'재개',confirm:'다시 적용하기'});
  await card(owner,lunch.id).getByRole('button',{name:'일시중지',exact:true}).waitFor();
  record('Pause reopens slots, while resume checks intervening reservations and preserves the paused state on conflict.');

  await card(owner,lunch.id).getByRole('button',{name:'수정',exact:true}).click();dialog=owner.locator('#dialog[open]');
  await dialog.locator('[name="frequency"]').selectOption('daily');await dialog.locator('[name="has_end_date"]').check();
  await dialog.locator('[name="end_date"]').fill(addDays(from,4));
  data=await preview(owner);assert.equal(data.occurrences.length,5);assert.equal(data.occurrences.at(-1).date,addDays(from,4));
  assert.equal((await save(owner,lunch.id)).status,200);
  await card(owner,lunch.id).getByText(/매일/).waitFor();
  const edited=(await recurrenceList(owner)).find(r=>r.id===lunch.id);assert.equal(edited.frequency,'daily');assert.equal(edited.end_date,addDays(from,4));
  assert.equal((await api(member,`/availability?date=${addDays(from,7)}`)).slots.find(s=>s.start_time==='13:00').available,true);
  record('Editing an existing rule applies an inclusive end date and stops blocking dates after it.');

  dialog=await openAdd(owner);await dialog.locator('[name="frequency"]').selectOption('biweekly');await setWeekdays(dialog,[1]);
  await dialog.locator('[name="start_date"]').fill(addDays(from,1));data=await preview(owner);
  assert.equal(data.occurrences[0].date,addDays(from,14));assert.equal(data.occurrences[1].date,addDays(from,28));
  assert.match(await dialog.locator('.recurring-frequency-hint').innerText(),/시작|한 주/);await capture(owner,'04-biweekly-preview');
  await dialog.locator('[name="frequency"]').selectOption('monthly');await dialog.locator('[name="monthly_mode"]').selectOption('day');
  await dialog.locator('[name="month_day"]').selectOption('31');data=await preview(owner);
  assert.ok(data.occurrences.length>=3);assert.ok(data.occurrences.every(o=>o.date.endsWith('-31')));
  await dialog.locator('[name="monthly_mode"]').selectOption('weekday');await dialog.locator('[name="month_week"]').selectOption('2');
  await dialog.locator('[name="month_weekday"]').selectOption('1');data=await preview(owner);
  assert.ok(data.occurrences.every(o=>{const d=new Date(`${o.date}T12:00:00Z`);return d.getUTCDay()===1&&d.getUTCDate()>=8&&d.getUTCDate()<=14;}));
  await dialog.locator('[name="month_week"]').selectOption('-1');data=await preview(owner);
  assert.ok(data.occurrences.every(o=>{const d=new Date(`${o.date}T12:00:00Z`);return d.getUTCDay()===1&&addDays(o.date,7).slice(0,7)!==o.date.slice(0,7);}));
  record('Biweekly previews retain the starting-week phase; monthly 31st, second Monday and last Monday previews agree with real calendar dates.');

  await owner.setViewportSize({width:390,height:844});await noOverflow(owner,'390px monthly preview');await capture(owner,'05-mobile-monthly-preview');
  await dialog.locator('[name="frequency"]').selectOption('biweekly');await noOverflow(owner,'390px weekdays');
  await closeDialog(owner);await noOverflow(owner,'390px owner settings');await capture(owner,'06-mobile-recurring-list');
  await owner.setViewportSize({width:1440,height:1050});record('Recurring form, month preview, weekdays and rule list fit a 390px phone viewport.');

  dialog=await openAdd(owner);await dialog.locator('[name="start_date"]').fill(addDays(from,7));
  await dialog.locator('[name="start_time"]').selectOption('16:00');await dialog.locator('[name="end_time"]').selectOption('17:00');
  await dialog.locator('[name="note"]').fill(`${runId} 재시도`);await preview(owner);
  const retryBodies=[];
  const loseFirst=async route=>{
    if(route.request().method()!=='POST')return route.continue();
    retryBodies.push(route.request().postDataJSON());const response=await route.fetch(),payload=await response.json();
    assert.equal(payload.ok,true,JSON.stringify(payload));ruleIds.add(payload.data.rule.id);
    return retryBodies.length===1?route.abort('failed'):route.fulfill({response});
  };
  await owner.route('**/api/admin/recurring-blocks',loseFirst);
  await dialog.getByRole('button',{name:'확인한 반복 잠금 저장',exact:true}).click();
  await dialog.locator('.recurring-status').getByText(/같은 요청 번호/).waitFor();
  assert.equal((await save(owner)).status,200);assert.deepEqual(retryBodies[0],retryBodies[1]);
  assert.equal((await recurrenceList(owner)).filter(r=>r.note===`${runId} 재시도`).length,1);
  await owner.unroute('**/api/admin/recurring-blocks',loseFirst);record('A lost creation response retries the same request UUID and does not duplicate a rule.');

  const delayedPreview=deferred(),holdPreview=async route=>delayedPreview.resolve({route,response:await route.fetch()});
  await owner.route('**/api/admin/recurring-blocks/preview',holdPreview);dialog=await openAdd(owner);
  await dialog.locator('[name="start_date"]').fill(addDays(from,7));
  await dialog.getByRole('button',{name:'반복 일정 미리보기',exact:true}).click();const held=await delayedPreview.promise;
  await dialog.locator('[name="note"]').fill('응답을 기다리는 동안 변경');
  response=owner.waitForResponse(routeIs('/admin/recurring-blocks/preview','POST'));await held.route.fulfill({response:held.response});await(await response).finished();await settle(owner);
  assert.equal(await dialog.locator('.recurring-preview').isVisible(),false);assert.equal(await dialog.locator('.recurring-confirmation').isVisible(),false);
  await owner.unroute('**/api/admin/recurring-blocks/preview',holdPreview);await closeDialog(owner);
  record('A late preview response cannot restore confirmation after the form has changed.');

  const rejectMember=await request(member,'/admin/recurring-blocks');assert.equal(rejectMember.status,403);
  await confirmAction(owner,{id:lunch.id,action:'전체 해제',confirm:'반복 잠금 해제하기',method:'DELETE'});
  await card(owner,lunch.id).waitFor({state:'hidden'});ruleIds.delete(lunch.id);
  await chooseDate(member,from);assert.equal(await slot(member,'13:00').isEnabled(),true);
  record('Whole-rule release removes the selected recurrence; approved customers cannot open the admin endpoint.');

  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
}finally{
  if(owner){
    for(const id of bookingIds){try{const data=await api(owner,`/bookings?from=${seoulToday()}&to=${addDays(seoulToday(),90)}`);const b=data.items.find(x=>x.id===id);if(b?.status==='confirmed')await api(owner,`/bookings/${id}/cancel`,'POST',{version:b.version,reason:'합성 테스트 정리'});}catch(e){console.error(`Cleanup booking: ${e.message}`);}}
    for(const id of blockIds){try{await api(owner,`/admin/blocks/${id}`,'DELETE',{});}catch(e){console.error(`Cleanup block: ${e.message}`);}}
    if(ruleIds.size){try{const data=await api(owner,'/admin/recurring-blocks');for(const r of data.items.filter(r=>ruleIds.has(r.id)))await api(owner,`/admin/recurring-blocks/${r.id}`,'DELETE',{version:r.version});}catch(e){console.error(`Cleanup recurring: ${e.message}`);}}
  }
  await writeFile(join(screenshotDir,'results.json'),JSON.stringify({results,errors,externalRequests},null,2));
  await Promise.all(contexts.map(c=>c.close()));await browser.close();
}
