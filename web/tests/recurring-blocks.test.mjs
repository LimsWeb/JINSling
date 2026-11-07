import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleApi} from '../server/api.mjs';
import {addDays,today} from '../server/support.mjs';
import {createTestDatabase,createTestAuth} from './sqlite-d1.mjs';
import {matchesRecurrence} from '../server/recurring-blocks.mjs';
import {RECURRENCE_SCHEMA,recurrenceMatchSql} from '../server/recurring-schema.mjs';

const BASE='/api/admin/recurring-blocks',PASSWORD='recurrence test password phrase';
let fixtureNumber=0;
function setup(){const db=createTestDatabase();return {...db,env:{DB:db.binding,BOOTSTRAP_TOKEN:'recurrence-setup-secret',AUTH:createTestAuth().auth},ip:`198.51.100.${++fixtureNumber}`};}
async function request(s,method,path,body,cookie,headers={}){
 const response=await handleApi(new Request(`https://example.test${path}`,{method,headers:{'X-JinSling-Request':'1',Origin:'https://example.test','CF-Connecting-IP':s.ip,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),s.env);
 const result=await response.json();return {status:response.status,...result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function owner(s){const result=await request(s,'POST','/api/bootstrap',{setup_token:'recurrence-setup-secret',name:'반복 관리자',phone:'010-1234-5678',username:'repeat_owner',password:PASSWORD});assert.equal(result.status,200,JSON.stringify(result));return result;}
async function member(s,a,approved=true){
 const invite=await request(s,'POST','/api/admin/invites',{},a.cookie);
 const result=await request(s,'POST','/api/auth/join',{invite_token:invite.data.invite_token,name:'비공개 반복 회원',phone:'010-2345-6789',username:`repeat_member_${fixtureNumber}`,password:PASSWORD});assert.equal(result.status,200,JSON.stringify(result));
 if(approved)assert.equal((await request(s,'PATCH',`/api/admin/users/${result.data.user.id}`,{status:'approved'},a.cookie)).status,200);
 return result;
}
function nextMonday(){let date=addDays(today(),1);while(new Date(`${date}T00:00:00Z`).getUTCDay()!==1)date=addDays(date,1);return date;}
const input=(extra={})=>({frequency:'weekly',weekdays:[1,2,3,4,5,6],start_date:nextMonday(),end_date:null,start_time:'13:00',end_time:'14:00',note:'점심시간 비공개 메모',enabled:true,...extra});
const preview=(s,a,body)=>request(s,'POST',BASE+'/preview',body,a.cookie);
const create=(s,a,body=input())=>request(s,'POST',BASE,{request_id:crypto.randomUUID(),...body},a.cookie);
const list=(s,a)=>request(s,'GET',BASE,undefined,a.cookie);
async function save(s,a,body=input()){const result=await create(s,a,body);assert.equal(result.status,200,JSON.stringify(result));return result.data.rule;}
async function day(s,a,date){const result=await request(s,'GET',`/api/availability?date=${date}`,undefined,a.cookie);assert.equal(result.status,200,JSON.stringify(result));return result.data;}
const slot=(data,time)=>data.slots.find(row=>row.start_time===time)?.status;
const booking=(s,a,date,start_time='13:00')=>request(s,'POST','/api/bookings',{date,start_time,memo:'비공개 예약 메모'},a.cookie);
const count=s=>Number(s.sqlite.prepare('SELECT count(*) n FROM recurring_blocks').get().n);
function removeRecurrenceSchema(s){
 for(const row of s.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'recurring_%'").all())s.sqlite.exec(`DROP TRIGGER ${row.name}`);
 s.sqlite.exec('DROP TABLE IF EXISTS recurring_block_exceptions; DROP TABLE IF EXISTS recurring_blocks;');
}

// Disabling authorization on any new mutation must expose this test failure.
test('recurrence endpoints require approved owner and same-origin JSON',async()=>{const s=setup();try{
 const a=await owner(s),u=await member(s,a,false),body=input(),id=crypto.randomUUID();
 const calls=[['GET',BASE,undefined],['POST',BASE+'/preview',body],['POST',BASE,{...body,request_id:id}],['PUT',BASE+'/'+id,{...body,version:1}],['PATCH',BASE+'/'+id,{enabled:false,version:1}],['DELETE',BASE+'/'+id,{version:1}],['PUT',`${BASE}/${id}/exceptions/${body.start_date}`,{version:1}],['DELETE',`${BASE}/${id}/exceptions/${body.start_date}`,{version:1}]];
 for(const [method,path,value]of calls){assert.equal((await request(s,method,path,value)).status,401);assert.equal((await request(s,method,path,value,u.cookie)).status,403);}
 assert.equal((await request(s,'PATCH',`/api/admin/users/${u.data.user.id}`,{status:'approved'},a.cookie)).status,200);
 for(const [method,path,value]of calls)assert.equal((await request(s,method,path,value,u.cookie)).error.code,'forbidden');
 assert.equal((await request(s,'POST',BASE,body,a.cookie,{Origin:'https://attacker.test'})).status,403);
 assert.equal((await preview(s,a,body)).status,200);
}finally{s.close();}});

test('weekly lunch blocks both customer availability routes and database booking writes',async()=>{const s=setup();try{
 const a=await owner(s),u=await member(s,a),date=nextMonday(),before=await day(s,u,date),rule=await save(s,a),d=await day(s,u,date);
 assert.equal(slot(d,'12:30'),'available');assert.equal(slot(d,'13:00'),'blocked');assert.equal(slot(d,'13:30'),'blocked');assert.equal(slot(d,'14:00'),'available');assert.equal(d.available_count,before.available_count-2);
 const calendar=await request(s,'GET',`/api/availability/calendar?month=${date.slice(0,7)}`,undefined,u.cookie);assert.equal(calendar.status,200);assert.equal(calendar.data.days.find(row=>row.date===date).available_count,d.available_count);
 for(const secret of [rule.id,rule.note,a.data.user.id,a.data.user.name]){assert.ok(!JSON.stringify(d).includes(secret));assert.ok(!JSON.stringify(calendar.data).includes(secret));}
 assert.equal((await booking(s,u,date)).status,409);assert.equal((await booking(s,a,date)).status,409);
 const free=await booking(s,a,date,'14:00');assert.equal(free.status,200);
 assert.equal((await request(s,'PATCH',`/api/bookings/${free.data.booking.id}`,{version:1,start_time:'13:00'},a.cookie)).status,409);
 assert.equal(s.sqlite.prepare('SELECT start_time,version FROM bookings WHERE id=?').get(free.data.booking.id).start_time,'14:00');
 assert.deepEqual((await list(s,a)).data.items.map(r=>r.id),[rule.id]);
}finally{s.close();}});

test('daily, biweekly and monthly previews use inclusive dates and Monday-based alternating weeks',async()=>{const s=setup(),clock=Date.now;try{
 const a=await owner(s);Date.now=()=>Date.parse('2027-01-01T03:00:00Z');
 const daily=await preview(s,a,input({frequency:'daily',start_date:'2027-01-01',end_date:'2027-01-03',start_time:'23:30',end_time:'24:00'}));assert.equal(daily.status,200,JSON.stringify(daily));assert.deepEqual(daily.data.occurrences.map(o=>o.date),['2027-01-01','2027-01-02','2027-01-03']);assert.ok(daily.data.occurrences.every(o=>o.end_time==='24:00'));
 const biweekly=await preview(s,a,input({frequency:'biweekly',weekdays:[1,3,6],start_date:'2027-01-06',end_date:'2027-01-23'}));assert.equal(biweekly.status,200);assert.deepEqual(biweekly.data.occurrences.map(o=>o.date),['2027-01-06','2027-01-09','2027-01-18','2027-01-20','2027-01-23']);
 const monthDay=await preview(s,a,input({frequency:'monthly',monthly_mode:'day',month_day:31,start_date:'2027-01-01',end_date:'2027-04-30'}));assert.equal(monthDay.status,200);assert.deepEqual(monthDay.data.occurrences.map(o=>o.date),['2027-01-31','2027-03-31']);
 const nth=await preview(s,a,input({frequency:'monthly',monthly_mode:'weekday',month_week:2,month_weekday:1,start_date:'2027-01-01',end_date:'2027-03-31'}));assert.equal(nth.status,200);assert.deepEqual(nth.data.occurrences.map(o=>o.date),['2027-01-11','2027-02-08','2027-03-08']);
 const last=await preview(s,a,input({frequency:'monthly',monthly_mode:'weekday',month_week:-1,month_weekday:6,start_date:'2027-01-01',end_date:'2027-03-31'}));assert.equal(last.status,200);assert.deepEqual(last.data.occurrences.map(o=>o.date),['2027-01-30','2027-02-27','2027-03-27']);
 assert.equal(count(s),0);
}finally{Date.now=clock;s.close();}});

test('existing bookings reject create, update and re-enable without cancellation or partial changes',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),b=await booking(s,a,date);assert.equal(b.status,200);
 const p=await preview(s,a,input());assert.equal(p.status,200);assert.equal(p.data.can_save,false);assert.equal(p.data.conflict_count,1);assert.deepEqual(p.data.conflicts,[{date,start_time:'13:00',end_time:'13:30'}]);
 assert.equal((await create(s,a)).status,409);assert.equal(count(s),0);
 const rule=await save(s,a,input({start_time:'14:00',end_time:'15:00'}));
 const changed=await request(s,'PUT',BASE+'/'+rule.id,{...input(),version:rule.version},a.cookie);assert.equal(changed.status,409);assert.equal((await list(s,a)).data.items[0].start_time,'14:00');
 const paused=await save(s,a,input({enabled:false}));assert.equal((await request(s,'PATCH',BASE+'/'+paused.id,{enabled:true,version:paused.version},a.cookie)).status,409);
 assert.equal(s.sqlite.prepare('SELECT status,version FROM bookings WHERE id=?').get(b.data.booking.id).status,'confirmed');
}finally{s.close();}});

test('one-date exceptions preserve overlapping locks and restoration refuses a booking race',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),first=await save(s,a),second=await save(s,a,input({note:'다른 잠금',start_time:'13:30',end_time:'14:00'}));
 const opened=await request(s,'PUT',`${BASE}/${first.id}/exceptions/${date}`,{version:first.version},a.cookie);assert.equal(opened.status,200,JSON.stringify(opened));assert.equal(opened.data.rule.version,first.version+1);assert.deepEqual(opened.data.rule.exceptions,[date]);
 const d=await day(s,a,date);assert.equal(slot(d,'13:00'),'available');assert.equal(slot(d,'13:30'),'blocked');assert.equal(slot(await day(s,a,addDays(date,1)),'13:00'),'blocked');
 assert.equal((await booking(s,a,date)).status,200);
 assert.equal((await request(s,'DELETE',`${BASE}/${first.id}/exceptions/${date}`,{version:opened.data.rule.version},a.cookie)).status,409);
 const retained=(await list(s,a)).data.items.find(r=>r.id===first.id);assert.equal(retained.version,opened.data.rule.version);assert.deepEqual(retained.exceptions,[date]);
 assert.equal((await request(s,'DELETE',BASE+'/'+second.id,{version:second.version},a.cookie)).status,200);assert.equal(slot(await day(s,a,date),'13:30'),'available');
}finally{s.close();}});

test('rule and exception mutations reject stale versions, while pause and deletion keep other rules effective',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),rule=await save(s,a),other=await save(s,a,input({start_time:'13:30'}));
 const paused=await request(s,'PATCH',BASE+'/'+rule.id,{enabled:false,version:rule.version},a.cookie);assert.equal(paused.status,200);assert.equal(paused.data.rule.enabled,false);
 for(const [method,path,body]of [['PUT',BASE+'/'+rule.id,{...input(),version:rule.version}],['PATCH',BASE+'/'+rule.id,{enabled:true,version:rule.version}],['DELETE',BASE+'/'+rule.id,{version:rule.version}],['PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version}]]){const result=await request(s,method,path,body,a.cookie);assert.equal(result.status,409);assert.equal(result.error.code,'stale_version');}
 assert.equal(slot(await day(s,a,date),'13:00'),'available');assert.equal(slot(await day(s,a,date),'13:30'),'blocked');
 const resumed=await request(s,'PATCH',BASE+'/'+rule.id,{enabled:true,version:paused.data.rule.version},a.cookie);assert.equal(resumed.status,200);assert.equal(slot(await day(s,a,date),'13:00'),'blocked');
 assert.equal((await request(s,'DELETE',BASE+'/'+rule.id,{version:resumed.data.rule.version},a.cookie)).status,200);assert.deepEqual((await list(s,a)).data.items.map(r=>r.id),[other.id]);
}finally{s.close();}});

test('create request identity survives edits, deletion and concurrent retries without resurrecting rules',async()=>{const s=setup();try{
 const a=await owner(s),body={...input(),request_id:crypto.randomUUID()};
 const both=await Promise.all([create(s,a,body),create(s,a,body)]);assert.deepEqual(both.map(r=>r.status),[200,200]);assert.equal(both[0].data.rule.id,both[1].data.rule.id);assert.equal(count(s),1);
 let rule=both[0].data.rule;const changed=await request(s,'PUT',BASE+'/'+rule.id,{...input({note:'수정한 메모'}),version:rule.version},a.cookie);assert.equal(changed.status,200);rule=changed.data.rule;
 const retry=await create(s,a,body);assert.equal(retry.status,200);assert.equal(retry.data.rule.note,'수정한 메모');assert.equal(count(s),1);
 assert.equal((await create(s,a,{...body,note:'다른 요청'})).error.code,'idempotency_conflict');
 assert.equal((await request(s,'DELETE',BASE+'/'+rule.id,{version:rule.version},a.cookie)).status,200);assert.equal((await create(s,a,body)).status,200);assert.deepEqual((await list(s,a)).data.items,[]);assert.equal(count(s),1);
 const collision={...input(),request_id:crypto.randomUUID()},pair=await Promise.all([create(s,a,collision),create(s,a,{...collision,note:'동시 다른 요청'})]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);assert.equal(pair.find(r=>r.status===409).error.code,'idempotency_conflict');
}finally{s.close();}});

test('new installs are additive, lazy, idempotent and leave existing records unchanged',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),b=await booking(s,a,date,'15:00');assert.equal(b.status,200);removeRecurrenceSchema(s);
 const before=s.sqlite.prepare('SELECT * FROM bookings').all(),initial=await list(s,a);assert.equal(initial.status,200);assert.deepEqual(initial.data,{items:[],schema_ready:false});
 assert.equal(slot(await day(s,a,date),'13:00'),'available');assert.equal((await preview(s,a,input())).status,200);assert.equal(s.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recurring_blocks'").get().n,0);
 await save(s,a);assert.equal((await list(s,a)).data.schema_ready,true);assert.deepEqual(s.sqlite.prepare('SELECT * FROM bookings').all(),before);assert.equal(s.sqlite.prepare("SELECT count(*) n FROM d1_migrations WHERE name='0003_recurring_blocks.sql'").get().n,1);
 await save(s,a,input({start_time:'14:00',end_time:'14:30'}));assert.equal(s.sqlite.prepare("SELECT count(*) n FROM d1_migrations WHERE name='0003_recurring_blocks.sql'").get().n,1);
}finally{s.close();}});

test('partial schema fails closed for bookings and availability but owner can repair it by saving',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),rule=await save(s,a);s.sqlite.exec('DROP TRIGGER recurring_booking_guard_insert');
 const listed=await list(s,a);assert.equal(listed.status,200);assert.equal(listed.data.schema_ready,false);assert.equal(listed.data.items[0].id,rule.id);
 for(const path of [`/api/availability?date=${date}`,`/api/availability/calendar?month=${date.slice(0,7)}`])assert.equal((await request(s,'GET',path,undefined,a.cookie)).status,503);
 assert.equal((await booking(s,a,date,'15:00')).status,503);assert.equal((await preview(s,a,input({id:rule.id,version:rule.version}))).status,200);
 assert.equal((await request(s,'PUT',BASE+'/'+rule.id,{...input(),version:rule.version},a.cookie)).status,200);assert.equal((await list(s,a)).data.schema_ready,true);assert.equal(slot(await day(s,a,date),'13:00'),'blocked');
}finally{s.close();}});

test('a failed schema batch rolls back all new tables and leaves an old database usable',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday();removeRecurrenceSchema(s);let injected=false;
 s.env.DB={prepare:sql=>s.binding.prepare(sql),async batch(statements){if(!injected){injected=true;return s.binding.batch([...statements,s.binding.prepare('SELECT * FROM intentionally_missing_setup_table')]);}return s.binding.batch(statements);}};
 assert.equal((await create(s,a)).status,500);assert.equal(injected,true);assert.equal(s.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='recurring_blocks'").get().n,0);
 assert.equal(slot(await day(s,a,date),'13:00'),'available');s.env.DB=s.binding;await save(s,a);assert.equal((await list(s,a)).data.schema_ready,true);
}finally{s.close();}});

test('invalid recurrence values and nonmatching exceptions cannot write, and active rule count is bounded',async()=>{const s=setup();try{
 const a=await owner(s),body=input(),invalid=[{frequency:['daily']},{frequency:'yearly'},{weekdays:[]},{weekdays:[1,1]},{weekdays:[7]},{weekdays:['1']},{start_date:'2027-02-29'},{end_date:addDays(body.start_date,-1)},{start_time:'13:15'},{start_time:'14:00',end_time:'13:00'},{end_time:'24:30'},{enabled:1},{note:'x'.repeat(501)},{frequency:'monthly',monthly_mode:'day',month_day:0},{frequency:'monthly',monthly_mode:'weekday',month_week:0,month_weekday:1},{frequency:'monthly',monthly_mode:'weekday',month_week:1,month_weekday:7},{request_id:'invalid'},{created_by:'forged'}];
 for(const extra of invalid){const result=await create(s,a,{...body,...extra});assert.equal(result.status,400,JSON.stringify(extra));}
 assert.equal(count(s),0);const rule=await save(s,a,input({weekdays:[1]}));
 for(const date of [addDays(body.start_date,1),addDays(today(),-1),addDays(today(),366)])assert.equal((await request(s,'PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version},a.cookie)).status,400);
 for(let n=1;n<32;n++)await save(s,a,input({note:`잠금 ${n}`}));assert.equal(count(s),32);assert.equal((await create(s,a)).status,409);assert.equal(count(s),32);
}finally{s.close();}});

test('editing a rule preserves its original past start and retained one-day exceptions',async()=>{const s=setup(),clock=Date.now;try{
 const a=await owner(s),rule=await save(s,a),date=addDays(rule.start_date,1),opened=await request(s,'PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version},a.cookie);assert.equal(opened.status,200);
 Date.now=()=>Date.parse(rule.start_date+'T15:30:00Z');
 const changed=await request(s,'PUT',BASE+'/'+rule.id,{...input({start_date:rule.start_date,note:'다음 날 수정'}),version:opened.data.rule.version},a.cookie);assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(changed.data.rule.start_date,rule.start_date);assert.deepEqual(changed.data.rule.exceptions,[date]);
 assert.equal((await create(s,a,input({start_date:rule.start_date}))).status,400);
}finally{Date.now=clock;s.close();}});

// A complete named SQL object set must be the same for automatic and CLI setup.
test('checked-in migration is identical to the runtime additive schema',()=>{
 const migration=readFileSync(new URL('../migrations/0003_recurring_blocks.sql',import.meta.url),'utf8');
 assert.equal(migration.replace(/^--.*\n/gm,'').trim(),RECURRENCE_SCHEMA.map(sql=>sql+';').join('\n\n'));
});

// Compare the display evaluator with the actual SQL predicate over leap days,
// year boundaries and all monthly ordinals, rather than just example weekdays.
test('JavaScript and SQL recurrence dates agree across leap and non-leap centuries',()=>{const s=setup();try{
 const defaults={frequency:'daily',start_date:'2027-12-29',end_date:null,weekdays_mask:0,monthly_mode:null,month_day:null,month_week:null,month_weekday:null};
 const cases=[defaults,{...defaults,frequency:'weekly',weekdays_mask:62},{...defaults,frequency:'biweekly',weekdays_mask:127},{...defaults,frequency:'biweekly',weekdays_mask:65,start_date:'2027-12-26',end_date:'2028-03-02'}];
 for(const month_day of [1,28,29,30,31])cases.push({...defaults,frequency:'monthly',monthly_mode:'day',month_day});
 for(const month_week of [1,2,3,4,5,-1])for(const month_weekday of [0,1,6])cases.push({...defaults,frequency:'monthly',monthly_mode:'weekday',month_week,month_weekday});
 const columns=Object.keys(defaults),statement=s.sqlite.prepare(`SELECT ${recurrenceMatchSql('r','d.value')} AS matches FROM (SELECT ${columns.map(k=>`? AS ${k}`).join(',')}) r CROSS JOIN (SELECT ? AS value) d`);
 for(const base of cases)for(const year of [2027,2099,2399]){
  const rule={...base,start_date:base.start_date.replace('2027',String(year)),end_date:base.end_date?.replace('2028',String(year+1))??null};
  const start=`${year}-12-20`,args=columns.map(k=>rule[k]);
  for(let i=0;i<440;i++){const date=addDays(start,i),sql=!!statement.get(...args,date).matches;assert.equal(matchesRecurrence(rule,date),sql,`${JSON.stringify(rule)} ${date}`);}
 }
 const leap={...defaults,frequency:'monthly',monthly_mode:'day',month_day:29};assert.equal(matchesRecurrence(leap,'2028-02-29'),true);
 const lastMonday={...defaults,frequency:'monthly',monthly_mode:'weekday',month_week:-1,month_weekday:1};assert.equal(matchesRecurrence(lastMonday,'2028-02-28'),true);assert.equal(matchesRecurrence(lastMonday,'2028-02-21'),false);
}finally{s.close();}});

function interceptWrite(s,match,before){
 let fired=false;
 const wrap=(sql,statement)=>({bind(...args){return wrap(sql,statement.bind(...args));},first(...args){return statement.first(...args);},all(){return statement.all();},execute(){return statement.execute();},async run(){if(!fired&&match.test(sql)){fired=true;await before();}return statement.run();}});
 s.env.DB={prepare:sql=>wrap(sql,s.binding.prepare(sql)),batch:statements=>s.binding.batch(statements)};
 return ()=>fired;
}
function directBook(s,a,date,start=780){const id=crypto.randomUUID();s.sqlite.prepare("INSERT INTO bookings(id,user_id,customer_name,phone,date,start_min,end_min,start_time,end_time,status,updated_by) VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?)").run(id,a.data.user.id,'경쟁 예약','010-5555-6666',date,start,start+30,`${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`,`${String(Math.floor((start+30)/60)).padStart(2,'0')}:${String((start+30)%60).padStart(2,'0')}`,a.data.user.id);return id;}

test('booking committed after preview and immediately before rule insertion wins atomically',async()=>{const s=setup();try{
 const a=await owner(s),body=input();assert.equal((await preview(s,a,body)).data.can_save,true);
 const fired=interceptWrite(s,/^INSERT INTO recurring_blocks\(/,()=>directBook(s,a,body.start_date));
 const result=await create(s,a,body);assert.equal(fired(),true);assert.equal(result.status,409);assert.equal(count(s),0);assert.equal(s.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE entity_type='recurring_block'").get().n,0);
 assert.equal(s.sqlite.prepare("SELECT count(*) n FROM bookings WHERE status='confirmed'").get().n,1);
}finally{s.close();}});

test('booking committed before exception restoration wins and preserves exception and version',async()=>{const s=setup();try{
 const a=await owner(s),rule=await save(s,a),date=rule.start_date,opened=await request(s,'PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version},a.cookie);assert.equal(opened.status,200);
 const before=s.sqlite.prepare('SELECT * FROM recurring_blocks WHERE id=?').get(rule.id),fired=interceptWrite(s,/^UPDATE recurring_block_exceptions SET active=0/,()=>directBook(s,a,date));
 const result=await request(s,'DELETE',`${BASE}/${rule.id}/exceptions/${date}`,{version:opened.data.rule.version},a.cookie);assert.equal(fired(),true);assert.equal(result.status,409);assert.deepEqual(s.sqlite.prepare('SELECT * FROM recurring_blocks WHERE id=?').get(rule.id),before);assert.equal(s.sqlite.prepare('SELECT active FROM recurring_block_exceptions WHERE rule_id=? AND date=?').get(rule.id,date).active,1);
 assert.throws(()=>s.sqlite.prepare('DELETE FROM recurring_block_exceptions WHERE rule_id=? AND date=?').run(rule.id,date),/recurring_conflict/);
}finally{s.close();}});

test('rule committed first blocks raw SQL writes and competing version changes have one winner',async()=>{const s=setup();try{
 const a=await owner(s),rule=await save(s,a),date=rule.start_date;assert.throws(()=>directBook(s,a,date),/recurring_conflict/);
 const pair=await Promise.all([request(s,'PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version},a.cookie),request(s,'PUT',`${BASE}/${rule.id}/exceptions/${addDays(date,1)}`,{version:rule.version},a.cookie)]);
 assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);assert.equal(pair.find(r=>r.status===409).error.code,'stale_version');
 const current=(await list(s,a)).data.items[0];assert.equal(current.version,rule.version+1);assert.equal(current.exceptions.length,1);
}finally{s.close();}});

test('exception audit failure rolls back exception row, parent version and earlier audit inserts',async()=>{const s=setup();try{
 const a=await owner(s),rule=await save(s,a),before=s.sqlite.prepare('SELECT * FROM recurring_blocks WHERE id=?').get(rule.id),audits=s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 s.sqlite.exec("CREATE TRIGGER reject_recurring_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='recurring_block' AND NEW.action='update' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;");
 assert.equal((await request(s,'PUT',`${BASE}/${rule.id}/exceptions/${rule.start_date}`,{version:rule.version},a.cookie)).status,500);
 assert.equal(s.sqlite.prepare('SELECT count(*) n FROM recurring_block_exceptions').get().n,0);assert.equal(s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);assert.deepEqual(s.sqlite.prepare('SELECT * FROM recurring_blocks WHERE id=?').get(rule.id),before);
}finally{s.close();}});

test('paused exceptions may be restored but reactivation still rejects the existing reservation',async()=>{const s=setup();try{
 const a=await owner(s),rule=await save(s,a),date=rule.start_date,opened=await request(s,'PUT',`${BASE}/${rule.id}/exceptions/${date}`,{version:rule.version},a.cookie),paused=await request(s,'PATCH',BASE+'/'+rule.id,{version:opened.data.rule.version,enabled:false},a.cookie);assert.equal(paused.status,200);assert.equal((await booking(s,a,date)).status,200);
 const restored=await request(s,'DELETE',`${BASE}/${rule.id}/exceptions/${date}`,{version:paused.data.rule.version},a.cookie);assert.equal(restored.status,200);assert.deepEqual(restored.data.rule.exceptions,[]);
 assert.equal((await request(s,'PATCH',BASE+'/'+rule.id,{version:restored.data.rule.version,enabled:true},a.cookie)).status,409);
}finally{s.close();}});

test('null enabled is rejected instead of silently enabling a submitted rule',async()=>{const s=setup();try{const a=await owner(s);assert.equal((await create(s,a,input({enabled:null}))).status,400);assert.equal(count(s),0);}finally{s.close();}});

test('repair never accepts an unchanged active rule that already overlaps a booking',async()=>{const s=setup();try{
 const a=await owner(s),rule=await save(s,a);s.sqlite.exec('DROP TRIGGER recurring_booking_guard_insert');directBook(s,a,rule.start_date);
 assert.equal((await request(s,'PUT',BASE+'/'+rule.id,{...input(),version:rule.version},a.cookie)).status,409);
 assert.equal((await request(s,'PATCH',BASE+'/'+rule.id,{enabled:false,version:rule.version},a.cookie)).status,200);assert.equal((await list(s,a)).data.schema_ready,true);
}finally{s.close();}});

test('a reservation already in progress still prevents a new routine, while completed slots may repeat tomorrow',async()=>{const s=setup();try{
 const a=await owner(s),local=new Date(Date.now()+9*3600000),date=local.toISOString().slice(0,10),minute=Math.floor((local.getUTCHours()*60+local.getUTCMinutes())/30)*30;
 const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
 // Simulate bookings made earlier: the ordinary insertion guard correctly
 // disallows adding past appointments now, so only that guard is removed here.
 s.sqlite.exec('DROP TRIGGER booking_guard_insert');const id=directBook(s,a,date,minute);
 const body=input({frequency:'daily',start_date:date,start_time:clock(minute),end_time:clock(minute+30)});
 const p=await preview(s,a,body);assert.equal(p.data.conflict_count,1);assert.equal((await create(s,a,body)).status,409);
 assert.equal((await request(s,'POST',`/api/bookings/${id}/cancel`,{version:1},a.cookie)).status,200);assert.equal((await create(s,a,body)).status,200);
 if(minute>=30){directBook(s,a,date,minute-30);const finished=input({frequency:'daily',start_date:date,start_time:clock(minute-30),end_time:clock(minute)});assert.equal((await preview(s,a,finished)).data.conflict_count,0);assert.equal((await create(s,a,finished)).status,200);}
}finally{s.close();}});
