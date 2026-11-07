// Optional real-browser integration; starts a fresh, loopback-only synthetic lab.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright':'playwright'));
const port=4187,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/dev.mjs',import.meta.url)),'--port',String(port)],{stdio:['ignore','pipe','pipe']});
let serverOutput='';server.stdout.on('data',v=>serverOutput+=v);server.stderr.on('data',v=>serverOutput+=v);
let browser;
const outcomes=[],errors=[];
function pass(text){outcomes.push(text);console.log('PASS '+text);}
const day=n=>new Date(Date.now()+9*3600000+n*86400000).toISOString().slice(0,10);
let date=day(2);if(new Date(date+'T00:00:00Z').getUTCDay()===0)date=day(3);
async function request(page,path,body){return page.evaluate(async({path,body})=>{
  const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-JinSling-Lab':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:response.status,...await response.json()};
},{path,body});}
async function selectedDate(page){await page.locator('input[name="date"]').fill(date);await page.locator('input[name="date"]').dispatchEvent('change');await page.getByRole('button',{name:'09:00 예약 가능',exact:true}).waitFor();}
async function openAccount(label){
  const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);await page.getByRole('button',{name:label,exact:true}).click();
  await page.getByRole('button',{name:'로그아웃',exact:true}).waitFor();return page;
}
async function confirm(page){await page.getByRole('button',{name:'확인하고 실행',exact:true}).click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});}

try{
  let ready=false;
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw new Error('Preview exited: '+serverOutput);
    try{if((await fetch(origin+'/api/session')).ok){ready=true;break;}}catch{}
    await delay(100);
  }
  assert.ok(ready,'Preview is ready');
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const member=await openAccount('회원 A 체험'),other=await openAccount('회원 B 체험'),owner=await openAccount('사장님 체험');
  await Promise.all([selectedDate(member),selectedDate(other),selectedDate(owner)]);
  await member.getByRole('button',{name:'10:00 예약 가능',exact:true}).click();
  await member.locator('#confirm-dialog').waitFor({state:'visible'});
  let data=await request(member,'/dashboard?date='+date);
  assert.equal(data.data.bookings.length,0,'Opening a proposal does not book');
  await confirm(member);
  data=await request(member,'/dashboard?date='+date);assert.equal(data.data.bookings.filter(b=>b.status==='booked').length,1);
  pass('Manual booking changes data only after explicit confirmation');

  await owner.getByRole('button',{name:'새로고침',exact:true}).click();
  await owner.getByRole('button',{name:'10:00 예약됨',exact:true}).waitFor();
  assert.equal((await request(owner,'/dashboard?date='+date)).data.bookings[0].member_name,'가상회원 A');
  await other.getByRole('button',{name:'새로고침',exact:true}).click();
  await other.getByRole('button',{name:'10:00 예약됨',exact:true}).waitFor();
  const anonymous=await request(other,'/dashboard?date='+date);assert.equal(anonymous.data.bookings.length,0);assert.equal('members' in anonymous.data,false);
  pass('Owner sees member booking; another member sees anonymous occupancy only');

  // The stale member screen held this option before another account took it.
  const occupied=await request(other,'/propose',{action:'book',data:{date,start_time:'10:00'}});
  assert.equal(occupied.status,409);
  pass('Occupied slot cannot become a second booking');

  await owner.locator('#block-period').selectOption('afternoon');
  await owner.getByRole('button',{name:'잠금 내용 확인',exact:true}).click();await confirm(owner);
  await member.getByRole('button',{name:'새로고침',exact:true}).click();
  await member.getByRole('button',{name:'12:00 잠김',exact:true}).waitFor();
  await owner.getByRole('button',{name:'해제',exact:true}).click();await confirm(owner);
  await member.getByRole('button',{name:'새로고침',exact:true}).click();
  await member.getByRole('button',{name:'12:00 예약 가능',exact:true}).waitFor();
  pass('Owner half-day lock and release update member availability');

  const pending=await openAccount('승인 대기 체험');
  await pending.getByRole('heading',{name:'승인을 기다리고 있어요.'}).waitFor();
  const pendingRow=owner.locator('.list-row').filter({hasText:'가상대기회원'});
  await pendingRow.getByRole('button',{name:'승인',exact:true}).click();await confirm(owner);
  await pending.getByRole('button',{name:'승인 상태 확인',exact:true}).click();
  await pending.getByRole('heading',{name:'편한 말로, 다음 예약'}).waitFor();
  assert.equal((await request(pending,'/session')).data.user.status,'approved');
  assert.equal((await request(member,'/propose',{action:'member_status',data:{member_id:'member_b',status:'suspended'}})).status,403);
  pass('Owner approval unlocks pending account; member cannot manage members');

  const chatText=date+' 13:00 예약';
  await member.locator('#chat-input').fill(chatText);
  await member.getByRole('button',{name:'보내기',exact:true}).click();
  await member.getByRole('button',{name:'내용 확인하고 실행',exact:true}).last().click();
  assert.equal((await request(member,'/dashboard?date='+date)).data.bookings.filter(b=>b.start_time==='13:00').length,0);
  await confirm(member);
  assert.equal((await request(member,'/dashboard?date='+date)).data.bookings.filter(b=>b.start_time==='13:00'&&b.status==='booked').length,1);
  assert.ok(await member.getByText('모의 대화 모드',{exact:true}).isVisible());
  pass('Simulation chat creates a reviewed proposal, not an immediate booking');

  await member.locator('#chat-input').fill('내 예약 보여줘');await member.getByRole('button',{name:'보내기',exact:true}).click();
  await member.locator('.message.assistant .chat-results').last().waitFor();
  const reply=await member.locator('.message.assistant').last().innerText();assert.ok(reply.includes(date));
  pass('Conversation lists the current member’s real stored reservations');

  await member.setViewportSize({width:390,height:844});await owner.setViewportSize({width:390,height:844});
  for(const page of [member,owner]){
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No mobile horizontal overflow');
  }
  if(process.env.SCREENSHOT_DIR){
    const dir=resolve(process.env.SCREENSHOT_DIR);await mkdir(dir,{recursive:true});
    await member.screenshot({path:dir+'/ai-member-mobile.png',fullPage:true});
    await owner.setViewportSize({width:1440,height:1100});await owner.screenshot({path:dir+'/ai-owner-desktop.png',fullPage:true});
  }
  pass('Owner and member layouts fit a 390-pixel viewport');
  assert.deepEqual(errors,[],'No browser script errors');
  console.log(JSON.stringify({passed:outcomes.length,model:'simulation only',date},null,2));
}finally{
  if(browser)await browser.close();
  server.kill('SIGTERM');
}
