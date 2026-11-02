// Optional browser regression against a local preview. All API responses are
// synthetic and intercepted; this script never writes to the preview database.
// JINSLING_TEST_ORIGIN=http://127.0.0.1:4176
// JINSLING_BROWSER_EXECUTABLE=/path/to/chromium node web/tests/browser/reservation-races.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {addDays,seoulToday} from '../../public/ui-utils.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright') : 'playwright');
const origin=new URL(process.env.JINSLING_TEST_ORIGIN||'http://127.0.0.1:4176').origin;
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname),
  'This script is restricted to a local preview.');
const browser=await chromium.launch({
  ...(process.env.JINSLING_BROWSER_EXECUTABLE?{executablePath:process.env.JINSLING_BROWSER_EXECUTABLE}:{}),
  headless:true,args:['--disable-dev-shm-usage'],
});
const errors=[],externalRequests=[];
const deferred=()=>{
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
};
const ok=(route,data)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data})});
const conflict=route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'conflict',message:'Synthetic conflict'}})});

async function fixture(){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin){externalRequests.push(route.request().url());return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror',error=>errors.push(error.message));
  const occupied=new Set();
  const state={holdAvailability:null,onBooking:null,reads:[],posts:[],occupy:(date,time)=>occupied.add(`${date} ${time}`)};
  const session={configured:true,auth_ready:true,
    user:{id:'synthetic-review-member',name:'가상 회원',username:'synthetic_review',role:'member',status:'approved'},
    settings:{shop_name:'가상 검증 매장',booking_window_days:30,cancel_before_minutes:0,contact_phone:''},
  };
  const day=date=>{
    const slots=[['09:00','09:30'],['09:30','10:00']].map(([start_time,end_time])=>{
      const booked=occupied.has(`${date} ${start_time}`);
      return {start_time,end_time,available:!booked,status:booked?'booked':'available'};
    });
    const booked_count=slots.filter(slot=>!slot.available).length;
    return {date,slots,booked_count,daily_limit:18,available_count:slots.length-booked_count,
      closed:false,status:booked_count===slots.length?'full':'available',reason:''};
  };
  await page.route('**/__preview/identities',route=>route.fulfill({status:404,body:''}));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    assert.equal(url.origin,origin);
    if(url.pathname==='/api/session')return ok(route,session);
    if(url.pathname==='/api/availability'||url.pathname==='/api/availability/calendar'){
      let data;
      if(url.pathname==='/api/availability')data=day(url.searchParams.get('date'));
      else{
        const month=url.searchParams.get('month'),last=new Date(`${month}-01T00:00:00Z`);
        last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
        data={month,days:Array.from({length:last.getUTCDate()},(_,index)=>{
          const {slots,...summary}=day(`${month}-${String(index+1).padStart(2,'0')}`);
          return summary;
        })};
      }
      const entry={route,data};state.reads.push(entry);
      if(state.holdAvailability?.(entry))return;
      return ok(route,data);
    }
    if(url.pathname==='/api/bookings'&&route.request().method()==='POST'){
      state.posts.push(route.request().postDataJSON());
      assert.equal(typeof state.onBooking,'function');
      return state.onBooking(route);
    }
    if(url.pathname==='/api/bookings')return ok(route,{items:[]});
    throw new Error(`Unexpected mocked API: ${url.pathname}`);
  });
  await page.goto(origin);
  await page.locator('.calendar-day[data-date]').first().waitFor();
  return {page,state,close:()=>context.close()};
}

async function chooseDate(page,date){
  for(let attempts=0;attempts<4&&!(await page.locator(`.calendar-day[data-date="${date}"]`).count());attempts++){
    const shown=await page.locator('.calendar-day[data-date]').first().getAttribute('data-date');
    await page.getByRole('button',{name:date.slice(0,7)<shown.slice(0,7)?'이전 달':'다음 달',exact:true}).click();
  }
  await page.locator(`.calendar-day[data-date="${date}"]`).click();
  await page.locator('.slot[data-time="09:00"]').waitFor();
}
const bookingButton=page=>page.getByRole('button',{name:'예약 내용 확인',exact:true});
const slot=(page,time)=>page.locator(`.slot[data-time="${time}"]`);

async function lateSubmissionAfterNavigation(status){
  const f=await fixture();
  try{
    const {page,state}=f,first=addDays(seoulToday(),2),next=addDays(seoulToday(),3),pending=deferred();
    state.onBooking=route=>{pending.resolve(route);};
    await chooseDate(page,first);await slot(page,'09:00').click();await bookingButton(page).click();
    await page.getByRole('button',{name:'예약 확정하기',exact:true}).click();
    const held=await pending.promise;
    await page.getByRole('button',{name:'창 닫기',exact:true}).click();
    await chooseDate(page,next);await slot(page,'09:30').click();
    const memo='다음 날짜의 가상 메모';await page.locator('textarea[name="memo"]').fill(memo);
    const response=page.waitForResponse(value=>value.url()===`${origin}/api/bookings`&&value.request().method()==='POST');
    if(status===409)await conflict(held);
    else await ok(held,{booking:{date:first,start_time:'09:00'}});
    await(await response).finished();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.locator('textarea[name="memo"]').inputValue(),memo);
    assert.match(await page.locator('.summary-time').innerText(),/09:30/);
    await bookingButton(page).click();
    await page.locator('#dialog[open]').waitFor();
    assert.match(await page.locator('#dialog').innerText(),/09:30/);
    assert.equal(state.posts.length,1,'A delayed completion must not cause another write.');
    console.log(`PASS delayed ${status} after navigation preserves the new selection, memo and confirmation`);
  }finally{await f.close();}
}

async function conflictInvalidatesPendingAvailability(){
  const f=await fixture();
  try{
    const {page,state}=f,date=addDays(seoulToday(),2),older=[],olderReady=deferred();
    await chooseDate(page,date);await slot(page,'09:00').click();
    const memo='충돌 뒤에도 유지되는 가상 메모';await page.locator('textarea[name="memo"]').fill(memo);
    const baseline=state.reads.length;
    state.holdAvailability=entry=>{older.push(entry);if(older.length===2)olderReady.resolve();return true;};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await olderReady.promise;
    await bookingButton(page).click();state.occupy(date,'09:00');state.onBooking=conflict;
    await page.getByRole('button',{name:'예약 확정하기',exact:true}).click();
    await page.getByRole('button',{name:'다른 시간 선택',exact:true}).waitFor();
    assert.equal(await page.locator('.slot:enabled').count(),0,'Choices stay disabled during conflict recovery.');
    await page.getByRole('button',{name:'다른 시간 선택',exact:true}).click();
    const fresh=[],freshReady=deferred();
    state.holdAvailability=entry=>{fresh.push(entry);if(fresh.length===2)freshReady.resolve();return true;};
    for(const entry of older)await ok(entry.route,entry.data);
    // A second request pair is observable evidence of a fresh read, independent
    // of the implementation's revision counters or promise structure.
    await Promise.race([freshReady.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Conflict recovery reused the older availability response.')),5_000))]);
    assert.equal(await slot(page,'09:00').isDisabled(),true,'The older free response must never re-enable this slot.');
    state.holdAvailability=null;
    for(const entry of fresh)await ok(entry.route,entry.data);
    await page.locator('.slot.booked[data-time="09:00"]:disabled').waitFor();
    assert.equal(await bookingButton(page).isDisabled(),true);
    assert.equal(await page.locator('textarea[name="memo"]').inputValue(),memo);
    assert.equal(state.reads.length-baseline,4,'One old pair and one fresh pair are sufficient.');
    assert.equal(state.posts.length,1,'Conflict recovery must not retry the booking write.');
    console.log('PASS conflict discards the pre-conflict availability pair and refreshes once without a second write');
  }finally{await f.close();}
}

try{
  await lateSubmissionAfterNavigation(409);
  await lateSubmissionAfterNavigation(200);
  await conflictInvalidatesPendingAvailability();
  assert.deepEqual(errors,[],'No browser runtime errors.');
  assert.deepEqual(externalRequests,[],'No external requests.');
}finally{await browser.close();}
