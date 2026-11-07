// Optional platform integration check against a compiled Pages worker and local
// Cloudflare D1/workerd. Uses only an in-memory synthetic pre-upgrade database.
// JINSLING_MINIFLARE_MODULE: installed miniflare package path (or normal resolution)
// JINSLING_WORKER_PATH: absolute path to the compiled _worker.js
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {addDays,today} from '../../server/support.mjs';

const require=createRequire(import.meta.url);
const {Miniflare,convertV4MiniflareOptions}=require(process.env.JINSLING_MINIFLARE_MODULE||'miniflare');
const workerPath=resolve(process.env.JINSLING_WORKER_PATH||'web/dist/_worker.js');
const options={modules:true,scriptPath:workerPath,modulesRoot:dirname(workerPath),compatibilityDate:'2026-10-30',d1Databases:['DB'],
  cf:false,telemetry:{enabled:false},serviceBindings:{ASSETS:async()=>new Response('synthetic static asset')}};
const mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
const origin='https://jinsling-runtime.invalid';
const secret=randomBytes(32).toString('base64url');
const cookie=`__Host-jinsling_session=${secret}`;
const ownerId='synthetic-runtime-owner';
let checks=0;
const pass=label=>{checks++;console.log(`PASS ${label}`);};
async function call(method,path,body,status=200){
  const response=await mf.dispatchFetch(`${origin}/api${path}`,{method,
    headers:{Origin:origin,Cookie:cookie,'X-JinSling-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`);return data;
}
try{
  const db=await mf.getD1Database('DB');
  // Reconstruct the exact old schema using SQLite's own parser, preserving
  // triggers and indexes without attempting to split trigger bodies by ';'.
  const old=new DatabaseSync(':memory:');
  for(const name of ['0001_initial.sql','0002_accounts.sql'])old.exec(readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
  const schema=old.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map(r=>r.sql);old.close();
  await db.batch(schema.map(sql=>db.prepare(sql)));
  const seed=[
    db.prepare("INSERT INTO settings(id,shop_name,contact_phone,booking_window_days,cancel_before_minutes,pilot_member_limit,member_limit,registration_open) VALUES(1,'합성 런타임 매장','',90,0,100,100,1)"),
    db.prepare("INSERT INTO users(id,name,phone,role,status,key_hash,username,provider_uid) VALUES(?,?,?,'admin','approved',?,?,?)").bind(ownerId,'합성 관리자','01000000001',randomUUID(),'runtime_owner','synthetic-provider-id'),
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,credential_revision,scope) VALUES(?,?,datetime('now','+1 day'),0,'full')").bind(createHash('sha256').update(secret).digest('hex'),ownerId)
  ];
  for(let weekday=0;weekday<7;weekday++)seed.push(db.prepare("INSERT INTO weekly_rules(weekday,closed,open_time,close_time,open_min,close_min,daily_limit,updated_by) VALUES(?,0,'09:00','20:00',540,1200,30,?)").bind(weekday,ownerId));
  await db.batch(seed);
  let date=addDays(today(),7);while(new Date(`${date}T12:00:00Z`).getUTCDay()!==1)date=addDays(date,1);
  let list=await call('GET','/admin/recurring-blocks');assert.equal(list.data.schema_ready,false);assert.deepEqual(list.data.items,[]);
  let day=await call('GET',`/availability?date=${date}`);assert.equal(day.data.slots.find(s=>s.start_time==='13:00').available,true);
  pass('Compiled worker reads the old database without requiring manual schema setup.');

  const body={frequency:'weekly',weekdays:[1,2,3,4,5,6],start_date:date,end_date:null,start_time:'13:00',end_time:'14:00',note:'합성 점심',enabled:true,request_id:randomUUID()};
  const preview=await call('POST','/admin/recurring-blocks/preview',Object.fromEntries(Object.entries(body).filter(([k])=>k!=='request_id')));
  assert.equal(preview.data.can_save,true);
  let saved=(await call('POST','/admin/recurring-blocks',body)).data.rule;
  list=await call('GET','/admin/recurring-blocks');assert.equal(list.data.schema_ready,true);assert.equal(list.data.items.length,1);
  assert.equal((await call('POST','/admin/recurring-blocks',body)).data.rule.id,saved.id);
  pass('First save installs D1 tables and guards atomically; a retry keeps one rule.');

  day=await call('GET',`/availability?date=${date}`);assert.equal(day.data.slots.find(s=>s.start_time==='13:00').status,'blocked');
  assert.equal(day.data.slots.find(s=>s.start_time==='14:00').status,'available');
  const calendar=await call('GET',`/availability/calendar?month=${date.slice(0,7)}`);
  assert.equal(calendar.data.days.find(d=>d.date===date).available_count,day.data.available_count);
  await call('POST','/bookings',{date,start_time:'13:00',memo:''},409);
  pass('Actual D1 triggers reject a blocked booking and calendar/day responses agree.');

  saved=(await call('PUT',`/admin/recurring-blocks/${saved.id}/exceptions/${date}`,{version:saved.version})).data.rule;
  const booking=(await call('POST','/bookings',{date,start_time:'13:00',memo:'합성 예외 예약'})).data.booking;
  await call('DELETE',`/admin/recurring-blocks/${saved.id}/exceptions/${date}`,{version:saved.version},409);
  assert.equal((await call('GET','/admin/recurring-blocks')).data.items[0].version,saved.version);
  await call('POST',`/bookings/${booking.id}/cancel`,{version:booking.version,reason:'합성 런타임 테스트'});
  saved=(await call('DELETE',`/admin/recurring-blocks/${saved.id}/exceptions/${date}`,{version:saved.version})).data.rule;
  await call('POST','/bookings',{date,start_time:'13:00',memo:''},409);
  pass('Exception restoration rolls back on reservation conflict, then succeeds after cancellation.');

  await call('DELETE',`/admin/recurring-blocks/${saved.id}`,{version:saved.version});
  const staleRetry=await call('POST','/admin/recurring-blocks',body);assert.equal(staleRetry.data.rule.id,saved.id);
  assert.equal((await call('GET','/admin/recurring-blocks')).data.items.length,0);
  assert.equal((await mf.dispatchFetch(`${origin}/guide.html`)).status,200);
  pass('Deleted recurrence stays deleted after a creation retry; static fallback still routes.');
  console.log(`Runtime checks passed: ${checks}`);
}finally{await mf.dispose();}
