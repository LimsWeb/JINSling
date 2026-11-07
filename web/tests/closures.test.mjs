import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../server/api.mjs';
import {addDays,today} from '../server/support.mjs';
import {createTestDatabase,createTestAuth} from './sqlite-d1.mjs';

const PASSWORD='closure test password phrase';
let fixtureNumber=0;
function setup(){const db=createTestDatabase();return {...db,env:{DB:db.binding,BOOTSTRAP_TOKEN:'closure-setup-secret',AUTH:createTestAuth().auth},ip:`192.0.2.${++fixtureNumber}`};}
async function request(s,method,path,body,cookie,headers={}){
 const response=await handleApi(new Request(`https://example.test${path}`,{method,headers:{'X-JinSling-Request':'1',Origin:'https://example.test','CF-Connecting-IP':s.ip,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),s.env);
 const result=await response.json();return {status:response.status,...result,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function owner(s){const result=await request(s,'POST','/api/bootstrap',{setup_token:'closure-setup-secret',name:'휴무 관리자',phone:'010-1234-5678',username:'closure_owner',password:PASSWORD});assert.equal(result.status,200,JSON.stringify(result));return result;}
async function member(s,a,{approved=false}={}){
 const invite=await request(s,'POST','/api/admin/invites',{},a.cookie);assert.equal(invite.status,200);
 const result=await request(s,'POST','/api/auth/join',{invite_token:invite.data.invite_token,name:'비공개 회원',phone:'010-2345-6789',username:`closure_member_${fixtureNumber}`,password:PASSWORD});assert.equal(result.status,200);
 if(approved)assert.equal((await request(s,'PATCH',`/api/admin/users/${result.data.user.id}`,{status:'approved'},a.cookie)).status,200);
 return result;
}
function nextMonday(){let date=addDays(today(),1);while(new Date(`${date}T00:00:00Z`).getUTCDay()!==1)date=addDays(date,1);return date;}
const payload=(date=nextMonday(),extra={})=>({from:date,to:date,period:'day',note:'정기 점검',...extra});
const preview=(s,a,body)=>request(s,'POST','/api/admin/blocks/preview',body,a.cookie);
const bulk=(s,a,body)=>request(s,'POST','/api/admin/blocks/bulk',body,a.cookie);
const release=(s,a,id)=>request(s,'DELETE',`/api/admin/block-batches/${id}`,{},a.cookie);
const count=(s,where='1=1')=>Number(s.sqlite.prepare(`SELECT count(*) n FROM blocks WHERE ${where}`).get().n);
const auditCount=s=>Number(s.sqlite.prepare("SELECT count(*) n FROM audit_log WHERE entity_type='block'").get().n);
async function book(s,a,date,start_time='09:00'){const result=await request(s,'POST','/api/bookings',{date,start_time,memo:'비공개 예약 메모',customer_name:'비공개 예약자',phone:'010-7777-9999'},a.cookie);assert.equal(result.status,200,JSON.stringify(result));return result.data.booking;}
async function availability(s,a,date){const result=await request(s,'GET',`/api/availability?date=${date}`,undefined,a.cookie);assert.equal(result.status,200);return result.data;}

// These tests fail if any bulk route bypasses authentication or owner approval.
test('bulk closure routes require an approved owner and same-origin JSON mutations',async()=>{const s=setup();try{
 const a=await owner(s),u=await member(s,a),id=crypto.randomUUID(),body=payload(undefined,{request_id:id});
 for(const [method,path,value] of [['POST','/api/admin/blocks/preview',body],['POST','/api/admin/blocks/bulk',body],['DELETE',`/api/admin/block-batches/${id}`,{}]]){
  assert.equal((await request(s,method,path,value)).status,401);
  assert.equal((await request(s,method,path,value,u.cookie)).status,403);
 }
 assert.equal((await request(s,'PATCH',`/api/admin/users/${u.data.user.id}`,{status:'approved'},a.cookie)).status,200);
 for(const [method,path,value] of [['POST','/api/admin/blocks/preview',body],['POST','/api/admin/blocks/bulk',body],['DELETE',`/api/admin/block-batches/${id}`,{}]])assert.equal((await request(s,method,path,value,u.cookie)).error.code,'forbidden');
 assert.equal((await request(s,'POST','/api/admin/blocks/preview',body,a.cookie,{Origin:'https://attacker.test'})).status,403);
 assert.equal((await preview(s,a,body)).status,200);
 assert.equal(count(s),0);assert.equal(auditCount(s),0);
}finally{s.close();}});

// Normalized periods and a fixed Seoul clock catch accidental UTC date boundaries.
test('preview normalizes day and half-day presets with inclusive dates and no writes',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),to=addDays(from,2);
 for(const [period,start_time,end_time] of [['day','00:00','24:00'],['morning','00:00','12:00'],['afternoon','12:00','24:00']]){
  const result=await preview(s,a,payload(from,{to,period,start_time:'08:30',end_time:'10:30'}));assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(result.data,{from,to,period,start_time,end_time,dates:[from,addDays(from,1),to],count:3,conflicts:[]});
 }
 const custom=await preview(s,a,payload(from,{period:'custom',start_time:'23:30',end_time:'24:00'}));assert.equal(custom.status,200);assert.equal(custom.data.start_time,'23:30');assert.equal(custom.data.end_time,'24:00');
 assert.equal(count(s),0);assert.equal(auditCount(s),0);
}finally{s.close();}});

test('closures enforce 1 to 31 dates and the Seoul today through day 365 window',async()=>{const s=setup(),realNow=Date.now;try{
 const a=await owner(s);Date.now=()=>Date.parse('2026-12-31T15:30:00Z');const from='2027-01-01';
 for(const body of [payload(from),payload(from,{to:addDays(from,30)}),payload(addDays(from,365))])assert.equal((await preview(s,a,body)).status,200,JSON.stringify(body));
 for(const body of [payload(addDays(from,-1)),payload(from,{to:addDays(from,31)}),payload(addDays(from,366)),payload(from,{to:addDays(from,-1)}),payload('2027-02-29'),payload('2027-1-01'),payload(null),payload(from,{to:null})]){
  const result=await preview(s,a,body);assert.equal(result.status,400,JSON.stringify(body));assert.equal(result.error.code,'invalid_input');
 }
 assert.equal(count(s),0);
}finally{Date.now=realNow;s.close();}});

test('custom intervals, UUIDs and note limits are validated before writes',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),id=crypto.randomUUID();
 const invalid=[{period:'custom'},{period:'custom',start_time:'10:15',end_time:'11:00'},{period:'custom',start_time:'24:00',end_time:'24:00'},{period:'custom',start_time:'12:00',end_time:'11:30'},{period:'custom',start_time:'09:00',end_time:'24:30'},{period:'custom',start_time:'09:00',end_time:'25:00'},{period:'night'},{note:'x'.repeat(501)},{note:3},{note:'bad\u0000note'},{actor_id:'forged'}, {request_id:'not-a-uuid'}];
 for(const extra of invalid){const result=await bulk(s,a,payload(date,{request_id:id,...extra}));assert.equal(result.status,400,JSON.stringify(extra));assert.equal(result.error.code,'invalid_input');}
 assert.equal((await bulk(s,a,payload(date))).status,400);
 assert.equal((await release(s,a,'not-a-uuid')).status,400);
 const result=await bulk(s,a,payload(date,{period:'custom',start_time:'09:30',end_time:'10:00',note:'x'.repeat(500),request_id:id}));assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.items.length,1);
}finally{s.close();}});

// Booking overlap is strict so adjacent bookings and cancelled bookings remain valid.
test('preview exposes anonymous confirmed booking conflicts and bulk rejects the entire range',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),to=addDays(from,2),b=await book(s,a,addDays(from,1),'10:00'),cancelled=await book(s,a,to,'10:00');
 assert.equal((await request(s,'POST',`/api/bookings/${cancelled.id}/cancel`,{version:1},a.cookie)).status,200);
 const body=payload(from,{to,period:'custom',start_time:'09:30',end_time:'10:30',request_id:crypto.randomUUID()}),before=s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
 const result=await preview(s,a,body);assert.equal(result.status,200);assert.deepEqual(result.data.conflicts,[{date:b.date,start_time:'10:00',end_time:'10:30'}]);
 for(const secret of [b.id,b.customer_name,b.phone,b.memo,a.data.user.id])assert.ok(!JSON.stringify(result.data).includes(secret));
 assert.equal((await bulk(s,a,body)).status,409);assert.equal(count(s),0);assert.equal(auditCount(s),0);assert.deepEqual(s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(b.id),before);
 assert.deepEqual((await preview(s,a,{...body,start_time:'10:30',end_time:'11:00'})).data.conflicts,[]);
 assert.equal((await bulk(s,a,{...body,start_time:'10:30',end_time:'11:00'})).status,200);
}finally{s.close();}});

test('booking arriving after preview aborts all block and audit inserts in the batch',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),last=addDays(from,2),body=payload(from,{to:last,request_id:crypto.randomUUID()});
 assert.deepEqual((await preview(s,a,body)).data.conflicts,[]);
 let injected=false;s.env.DB={prepare:sql=>s.binding.prepare(sql),async batch(statements){
  if(!injected){injected=true;await s.binding.prepare("INSERT INTO bookings(id,user_id,customer_name,phone,date,start_min,end_min,start_time,end_time,memo,status,updated_by) VALUES (?,?,?,?,?,540,570,'09:00','09:30','race booking','confirmed',?)").bind(crypto.randomUUID(),a.data.user.id,'경쟁 예약자','010-5555-6666',last,a.data.user.id).run();}
  return s.binding.batch(statements);
 }};
 const result=await bulk(s,a,body);assert.equal(injected,true);assert.equal(result.status,409,JSON.stringify(result));assert.equal(count(s),0);assert.equal(auditCount(s),0);
 assert.equal(s.sqlite.prepare("SELECT count(*) n FROM bookings WHERE date=? AND status='confirmed'").get(last).n,1);
}finally{s.close();}});

test('bulk creation is idempotent and publishes batch IDs with one audit record per date',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),id=crypto.randomUUID(),body=payload(from,{to:addDays(from,2),period:'morning',request_id:id});
 const first=await bulk(s,a,body);assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.data.batch_id,id);assert.equal(first.data.items.length,3);
 for(const item of first.data.items){assert.equal(item.batch_id,id);assert.equal(item.start_time,'00:00');assert.equal(item.end_time,'12:00');assert.equal(item.note,'정기 점검');assert.ok(item.id.includes(id));assert.ok(item.id.includes(item.date));}
 assert.deepEqual((await bulk(s,a,body)).data,first.data);assert.equal(count(s),3);assert.equal(auditCount(s),3);
 const list=await request(s,'GET',`/api/admin/blocks?from=${from}&to=${body.to}`,undefined,a.cookie);assert.deepEqual(list.data.items,first.data.items);
 const audit=s.sqlite.prepare("SELECT actor_name,after_data FROM audit_log WHERE entity_type='block' ORDER BY id").all();assert.ok(audit.every(row=>row.actor_name==='휴무 관리자'&&JSON.parse(row.after_data).deleted_at===null));
}finally{s.close();}});

test('request UUID cannot be reused with changed dates, period, time, note or actor',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),id=crypto.randomUUID(),body=payload(from,{request_id:id});assert.equal((await bulk(s,a,body)).status,200);
 for(const changed of [{from:addDays(from,1),to:addDays(from,1)},{to:addDays(from,1)},{period:'morning'},{period:'custom',start_time:'00:00',end_time:'24:00'},{note:'다른 사유'}]){
  const result=await bulk(s,a,{...body,...changed});assert.equal(result.status,409);assert.equal(result.error.code,'idempotency_conflict');
 }
 const second=await member(s,a,{approved:true});s.sqlite.exec('DROP INDEX one_administrator');s.sqlite.prepare("UPDATE users SET role='admin' WHERE id=?").run(second.data.user.id);
 const otherActor=await bulk(s,second,body);assert.equal(otherActor.status,409);assert.equal(otherActor.error.code,'idempotency_conflict');
 assert.equal(count(s),1);assert.equal(auditCount(s),1);
}finally{s.close();}});

test('concurrent identical requests create only one batch and concurrent changed payloads cannot reuse its UUID',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),body=payload(from,{to:addDays(from,1),request_id:crypto.randomUUID()});
 const same=await Promise.all([bulk(s,a,body),bulk(s,a,body)]);assert.deepEqual(same.map(r=>r.status),[200,200]);assert.deepEqual(same[0].data,same[1].data);assert.equal(count(s),2);assert.equal(auditCount(s),2);
 const id=crypto.randomUUID(),one=payload(addDays(from,3),{request_id:id}),other=payload(addDays(from,4),{request_id:id});
 const changed=await Promise.all([bulk(s,a,one),bulk(s,a,other)]);assert.deepEqual(changed.map(r=>r.status).sort(),[200,409]);assert.equal(changed.find(r=>r.status===409).error.code,'idempotency_conflict');assert.equal(count(s),3);assert.equal(auditCount(s),3);
}finally{s.close();}});

// A release cannot revive deleted rows or affect a separate overlapping closure.
test('single-block deletion followed by batch release removes only surviving blocks and retry does not resurrect them',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),body=payload(from,{to:addDays(from,2),request_id:crypto.randomUUID()}),created=await bulk(s,a,body);assert.equal(created.status,200);
 const first=created.data.items[0];assert.equal((await request(s,'DELETE',`/api/admin/blocks/${encodeURIComponent(first.id)}`,{},a.cookie)).status,200);
 const repeated=await bulk(s,a,body);assert.equal(repeated.status,200);assert.equal(repeated.data.items.length,2);assert.ok(repeated.data.items.every(item=>item.id!==first.id));assert.equal(count(s,'deleted_at IS NULL'),2);
 const removed=await release(s,a,body.request_id);assert.equal(removed.status,200);assert.deepEqual(removed.data,{batch_id:body.request_id,count:2});assert.equal(count(s,'deleted_at IS NULL'),0);assert.equal(auditCount(s),6);
 assert.deepEqual((await release(s,a,body.request_id)).data,{batch_id:body.request_id,count:0});assert.equal(auditCount(s),6);
 assert.deepEqual((await bulk(s,a,body)).data,{batch_id:body.request_id,items:[]});assert.equal(count(s),3);assert.equal(count(s,'deleted_at IS NULL'),0);assert.equal(auditCount(s),6);
 assert.equal((await bulk(s,a,{...body,note:'changed after release'})).error.code,'idempotency_conflict');
}finally{s.close();}});

test('overlapping groups and single blocks stay effective until each own release; existing bookings remain unchanged',async()=>{const s=setup();try{
 const a=await owner(s),date=nextMonday(),booking=await book(s,a,date,'15:00'),before=s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id);
 const first=await bulk(s,a,payload(date,{period:'morning',request_id:crypto.randomUUID()})),second=await bulk(s,a,payload(date,{period:'custom',start_time:'09:30',end_time:'10:30',request_id:crypto.randomUUID()}));assert.equal(first.status,200);assert.equal(second.status,200);
 const single=await request(s,'POST','/api/admin/blocks',{date,start_time:'10:30',end_time:'11:00',note:'별도 등록'},a.cookie);assert.equal(single.status,200);assert.equal(single.data.block.batch_id??null,null);
 assert.equal((await availability(s,a,date)).slots.find(slot=>slot.start_time==='09:00').status,'blocked');
 assert.equal((await release(s,a,first.data.batch_id)).data.count,1);
 let day=await availability(s,a,date);assert.equal(day.slots.find(slot=>slot.start_time==='09:00').status,'available');assert.equal(day.slots.find(slot=>slot.start_time==='09:30').status,'blocked');assert.equal(day.slots.find(slot=>slot.start_time==='10:30').status,'blocked');assert.equal(day.slots.find(slot=>slot.start_time==='15:00').status,'booked');
 assert.equal((await release(s,a,second.data.batch_id)).data.count,1);day=await availability(s,a,date);assert.equal(day.slots.find(slot=>slot.start_time==='09:30').status,'available');assert.equal(day.slots.find(slot=>slot.start_time==='10:30').status,'blocked');
 assert.equal((await request(s,'DELETE',`/api/admin/blocks/${single.data.block.id}`,{},a.cookie)).status,200);assert.equal((await availability(s,a,date)).slots.find(slot=>slot.start_time==='10:30').status,'available');
 assert.deepEqual(s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id),before);
}finally{s.close();}});

test('an audit failure rolls back the whole batch release',async()=>{const s=setup();try{
 const a=await owner(s),from=nextMonday(),body=payload(from,{to:addDays(from,2),request_id:crypto.randomUUID()}),created=await bulk(s,a,body);assert.equal(created.status,200);
 s.sqlite.exec(`CREATE TRIGGER deny_closure_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='block' AND NEW.action='update' AND json_extract(NEW.after_data,'$.date')='${body.to}' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;`);
 const result=await release(s,a,body.request_id);assert.equal(result.status,500);assert.equal(count(s,'deleted_at IS NULL'),3);assert.equal(auditCount(s),3);
 s.sqlite.exec('DROP TRIGGER deny_closure_audit');assert.equal((await release(s,a,body.request_id)).data.count,3);assert.equal(count(s,'deleted_at IS NULL'),0);assert.equal(auditCount(s),6);
}finally{s.close();}});

// Period values must remain strings at the HTTP boundary, without property coercion.
test('malformed period values return validation errors without accepting arrays or throwing',async()=>{const s=setup();try{
 const a=await owner(s);
 for(const period of [null,[],['day'],{}, {toString:'day'},0,true]){
  const result=await preview(s,a,payload(undefined,{period}));assert.equal(result.status,400,JSON.stringify(period));assert.equal(result.error.code,'invalid_input');
 }
 assert.equal(count(s),0);
}finally{s.close();}});
