import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

let handleApi, createTestDatabase, createTestAuth;
try { ({handleApi} = await import('../server/api.mjs')); ({createTestDatabase,createTestAuth} = await import('./sqlite-d1.mjs')); } catch {}
const PASSWORD='test correct password phrase', NEXT_PASSWORD='test replacement password phrase';
let memberNumber=0;
const setup = () => { assert.equal(typeof handleApi, 'function', 'real API must exist'); const db = createTestDatabase(); return { ...db, env:{DB:db.binding, BOOTSTRAP_TOKEN:'explicit-setup-secret',AUTH:createTestAuth().auth} }; };
let ip = 0;
async function req(s, method, path, body, cookie, extra={}) {
  const headers = {'X-JinSling-Request':'1',Origin:'https://example.test','CF-Connecting-IP':s.ip ||= `192.0.2.${++ip}`, ...extra};
  if(body !== undefined) headers['Content-Type']='application/json';
  if(cookie) headers.Cookie=cookie;
  const response = await handleApi(new Request(`https://example.test${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),s.env);
  let json; if(response.headers.get('content-type')?.includes('json')) json=await response.json();
  return {status:response.status,data:json?.data,error:json?.error,response,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function boot(s) { const r=await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'사장님',phone:'010-1234-5678',username:'shop_owner',password:PASSWORD}); assert.equal(r.status,200,JSON.stringify(r.error)); return r; }
async function member(s,admin,name='손님') { const inv=await req(s,'POST','/api/admin/invites',{},admin.cookie); assert.equal(inv.status,200); const r=await req(s,'POST','/api/auth/join',{invite_token:inv.data.invite_token,name,phone:'010-2345-6789',username:'member_'+(++memberNumber),password:PASSWORD}); assert.equal(r.status,200,JSON.stringify(r.error)); return {...r,invite:inv.data.invite_token}; }
async function approve(s,a,u) { assert.equal((await req(s,'PATCH',`/api/admin/users/${u.data.user.id}`,{status:'approved'},a.cookie)).status,200); }
function dateAhead(weekday=1,offset=1) { const d=new Date(Date.now()+9*3600000); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()+offset); while(d.getUTCDay()!==weekday)d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); }
async function book(s,a,time='09:00',date=dateAhead(),extra={}) { return req(s,'POST','/api/bookings',{date,start_time:time,memo:'테스트',...extra},a.cookie); }

test('bootstrap is explicit, single use; credentials stay private and cookies are secure',async()=>{const s=setup();try{
  assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'wrong',name:'A',phone:'01012345678'})).status,403);
  const a=await boot(s);assert.equal(a.data.login_key,undefined);assert.equal(a.data.user.username,'shop_owner');
  for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/'])assert.ok(a.response.headers.get('set-cookie').includes(flag));
  assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'B',phone:'01012345678'})).status,409);
  const tables=s.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();for(const t of tables){const rows=s.sqlite.prepare(`SELECT * FROM ${t.name}`).all();assert.ok(!JSON.stringify(rows).includes(PASSWORD));assert.ok(!JSON.stringify(rows).includes(a.cookie.split('=')[1]));}
  assert.equal((await req(s,'GET','/api/session',undefined,a.cookie)).data.user.role,'admin');
  await req(s,'POST','/api/auth/logout',{},a.cookie);assert.equal((await req(s,'GET','/api/session',undefined,a.cookie)).data.user,null);
  assert.equal((await req(s,'POST','/api/auth/login',{username:'shop_owner',password:PASSWORD})).status,200);
}finally{s.close();}});

test('authentication accepts only the exact __Host session cookie name at cookie boundaries',async()=>{const s=setup();try{
 const a=await boot(s);assert.equal((await req(s,'GET','/api/session',undefined,'unrelated-'+a.cookie)).data.user,null);assert.equal((await req(s,'GET','/api/admin/users',undefined,'unrelated-'+a.cookie)).status,401);
 assert.equal((await req(s,'GET','/api/session',undefined,'other=value;  '+a.cookie+'; last=value')).data.user.id,a.data.user.id);
}finally{s.close();}});

test('invitation single-use, one-time approval, configured capacity and suspension revoke sessions',async()=>{const s=setup();try{
 const a=await boot(s),u=await member(s,a);assert.equal((await book(s,u)).status,403);assert.equal((await req(s,'POST','/api/auth/join',{invite_token:u.invite,name:'replay',phone:'01012345678',username:'replay_member',password:PASSWORD})).status,403);
 await approve(s,a,u);assert.equal((await book(s,u)).status,200);
 const reset=await req(s,'POST',`/api/admin/users/${u.data.user.id}/reset-password`,{},a.cookie);assert.equal(reset.status,200);
 assert.equal((await req(s,'POST','/api/auth/login',{username:u.data.user.username,password:PASSWORD})).status,403);assert.equal((await book(s,u,'10:00')).status,401);
 const fresh=await req(s,'POST','/api/auth/reset-password',{reset_token:reset.data.reset_token,new_password:NEXT_PASSWORD});assert.equal(fresh.status,200);
 await req(s,'PATCH',`/api/admin/users/${u.data.user.id}`,{status:'suspended'},a.cookie);assert.equal((await book(s,fresh,'10:00')).status,401);
 await member(s,a,'2');await member(s,a,'3');await member(s,a,'4');
 const data=(await req(s,'GET','/api/admin/settings',undefined,a.cookie)).data;data.settings.member_limit=5;assert.equal((await req(s,'PUT','/api/admin/settings',data,a.cookie)).status,200);
 const inv=await req(s,'POST','/api/admin/invites',{},a.cookie);const full=await req(s,'POST','/api/auth/join',{invite_token:inv.data.invite_token,name:'6',phone:'01012345678',username:'sixth_member',password:PASSWORD});assert.equal(full.status,409);
 assert.equal((await req(s,'POST','/api/auth/invite-info',{invite_token:inv.data.invite_token})).data.valid,true);
 assert.equal((await req(s,'PATCH',`/api/admin/users/${a.data.user.id}`,{status:'suspended'},a.cookie)).status,409);
}finally{s.close();}});

test('booking ownership, optimistic updates, idempotency, cancellation and CSV protection',async()=>{const s=setup();try{
 const a=await boot(s),u=await member(s,a),v=await member(s,a,'다른 손님');await approve(s,a,u);await approve(s,a,v);
 const request_id=crypto.randomUUID(), b=await book(s,u,'09:00',dateAhead(),{request_id,memo:'=SUM(A1)'});assert.equal(b.status,200,JSON.stringify(b.error));
 const repeat=await book(s,u,'09:00',dateAhead(),{request_id,memo:'=SUM(A1)'});assert.equal(repeat.data.booking.id,b.data.booking.id);
 assert.equal((await book(s,u,'09:30',dateAhead(),{request_id,memo:'=SUM(A1)'})).status,409);
 assert.equal((await req(s,'GET','/api/bookings',undefined,v.cookie)).data.items.length,0);
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,memo:'bad'},v.cookie)).status,404);
 assert.equal((await req(s,'GET','/api/admin/users',undefined,u.cookie)).status,403);
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,start_time:'10:00'},u.cookie)).status,403);
 const edited=await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,memo:'=SUM(A1)'},u.cookie);assert.equal(edited.status,200);assert.equal(edited.data.booking.version,2);
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,memo:'stale'},u.cookie)).status,409);
 const csv=await req(s,'GET','/api/admin/export.csv',undefined,a.cookie);assert.equal(csv.status,200);assert.ok((await csv.response.text()).includes("'=SUM(A1)"));
 assert.equal((await req(s,'POST',`/api/bookings/${b.data.booking.id}/cancel`,{version:2},u.cookie)).data.booking.status,'cancelled');
 assert.equal((await book(s,v)).status,200);
}finally{s.close();}});

test('database enforces overlap, 18/10 capacity, grid, valid dates, future, hours and blocks atomically',async()=>{const s=setup();try{
 const a=await boot(s),day=dateAhead();
 for(let i=0;i<18;i++){const t=`${String(9+Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`;assert.equal((await book(s,a,t,day)).status,200);}
 assert.equal((await book(s,a,'18:00',day)).status,409);
 const sat=dateAhead(6);for(let i=0;i<10;i++)assert.equal((await book(s,a,`${String(9+Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`,sat)).status,200);
 assert.equal((await book(s,a,'14:00',sat)).status,409);
 for(const [date,time] of [[dateAhead(0),'09:00'],[dateAhead(2),'19:45'],['2026-02-30','09:00'],['2020-01-01','09:00'],[dateAhead(2),'20:00']])assert.ok((await book(s,a,time,date)).status>=400);
 const block=await req(s,'POST','/api/admin/blocks',{date:dateAhead(2),start_time:'10:00',end_time:'11:00',note:'휴식'},a.cookie);assert.equal(block.status,200);
 assert.equal((await book(s,a,'10:30',dateAhead(2))).status,409); assert.equal((await book(s,a,'11:00',dateAhead(2))).status,200);
 assert.equal((await req(s,'POST','/api/admin/blocks',{date:dateAhead(2),start_time:'11:00',end_time:'11:30',note:''},a.cookie)).status,409);
 assert.equal((await req(s,'DELETE',`/api/admin/blocks/${block.data.block.id}`,{},a.cookie)).status,200);assert.equal((await book(s,a,'10:00',dateAhead(2))).status,200);
 const rule=(await req(s,'GET','/api/admin/settings',undefined,a.cookie)).data;rule.weekly_rules[1].daily_limit=17;assert.equal((await req(s,'PUT','/api/admin/settings',rule,a.cookie)).status,409);
 assert.equal((await req(s,'GET','/api/admin/settings',undefined,a.cookie)).data.weekly_rules[1].daily_limit,18);
}finally{s.close();}});

test('failed move preserves original row and audit, same-date full-cap move works, audit is atomic',async()=>{const s=setup();try{
 const a=await boot(s),first=await book(s,a),second=await book(s,a,'09:30');const before=s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(first.data.booking.id);const audits=s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 assert.equal((await req(s,'PATCH',`/api/bookings/${first.data.booking.id}`,{version:1,start_time:'09:30'},a.cookie)).status,409);
 assert.deepEqual(s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(first.data.booking.id),before);assert.equal(s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);
 assert.equal((await req(s,'PATCH',`/api/bookings/${first.data.booking.id}`,{version:1,start_time:'10:00'},a.cookie)).data.booking.id,first.data.booking.id);
 const audit=await req(s,'GET','/api/admin/audit',undefined,a.cookie);assert.ok(audit.data.items.some(x=>x.entity_id===first.data.booking.id&&x.action==='update'));
 const getSettings=(await req(s,'GET','/api/admin/settings',undefined,a.cookie)).data;getSettings.weekly_rules[1].daily_limit=2;assert.equal((await req(s,'PUT','/api/admin/settings',getSettings,a.cookie)).status,200);
 assert.equal((await req(s,'PATCH',`/api/bookings/${first.data.booking.id}`,{version:2,start_time:'11:00'},a.cookie)).status,200);
}finally{s.close();}});

test('CSRF, bounds, no-bootstrap-secret, and authentication rate limiting',async()=>{const s=setup();try{
 assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'A',phone:'01012345678'},null,{Origin:'https://evil.test'})).status,403);
 assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'A',phone:'01012345678'},null,{'X-JinSling-Request':''})).status,403);
 assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'A',phone:'bad'})).status,400);
 const env=s.env;s.env={DB:s.binding};assert.equal((await req(s,'POST','/api/bootstrap',{setup_token:'explicit-setup-secret',name:'A',phone:'01012345678'})).status,403);s.env=env;
 for(let i=0;i<15;i++)await req(s,'POST','/api/auth/login',{login_key:'invalid'});assert.equal((await req(s,'POST','/api/auth/login',{login_key:'invalid'})).status,429);
 const a=await boot(s);assert.equal((await book(s,a,'09:00',dateAhead(),{memo:'a'.repeat(1001)})).status,400);
 assert.equal(a.response.headers.get('cache-control'),'no-store');
}finally{s.close();}});

test('SQLite adapter rolls back batches and persists across reopen',async()=>{assert.equal(typeof createTestDatabase,'function');const dir=mkdtempSync(join(tmpdir(),'jinsling-'));const path=join(dir,'db.sqlite');let s={...createTestDatabase(path)};s.env={DB:s.binding,BOOTSTRAP_TOKEN:'explicit-setup-secret',AUTH:createTestAuth().auth};try{
 const a=await boot(s);await book(s,a);await assert.rejects(s.binding.batch([s.binding.prepare("UPDATE settings SET shop_name='rollback' WHERE id=1"),s.binding.prepare('INSERT INTO missing_table VALUES (1)')]));assert.notEqual(s.sqlite.prepare('SELECT shop_name FROM settings').get().shop_name,'rollback');s.close();s=createTestDatabase(path);assert.equal(s.sqlite.prepare('SELECT count(*) n FROM bookings').get().n,1);
}finally{s.close();rmSync(dir,{recursive:true,force:true});}});

test('separate SQLite worker connections serialize simultaneous slot inserts to one reservation',{timeout:10000},async(t)=>{assert.equal(typeof createTestDatabase,'function');const dir=mkdtempSync(join(tmpdir(),'jinsling-race-'));const filename=join(dir,'db.sqlite');const s={...createTestDatabase(filename)};s.env={DB:s.binding,BOOTSTRAP_TOKEN:'explicit-setup-secret',AUTH:createTestAuth().auth};try{
 const a=await boot(s),date=dateAhead(),gate=new SharedArrayBuffer(4);const sql="INSERT INTO bookings (id,user_id,customer_name,phone,date,start_min,end_min,start_time,end_time,memo,status,version,updated_by) VALUES (?,?,?,?,?,540,570,'09:00','09:30','','confirmed',1,?)";
 const workers=[1,2].map(i=>new Worker(new URL('./race-worker.mjs',import.meta.url),{execArgv:[],workerData:{filename,gate,sql,args:[crypto.randomUUID(),a.data.user.id,'race','01012345678',date,a.data.user.id]}}));
 t.after(()=>Promise.all(workers.map(w=>w.terminate())));const exits=workers.map(w=>new Promise(r=>w.once('exit',r)));
 const ready=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);}));await Promise.all(ready);const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);}));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);const out=await Promise.all(results);await Promise.all(exits);assert.equal(out.filter(x=>x.ok).length,1);assert.equal(s.sqlite.prepare('SELECT count(*) n FROM bookings').get().n,1);
}finally{s.close();rmSync(dir,{recursive:true,force:true});}});

test('expired and revoked invites and sessions are refused; password change replaces cookie and audit never contains secrets',async()=>{const s=setup();try{
 const a=await boot(s);const inv=await req(s,'POST','/api/admin/invites',{},a.cookie);assert.match(inv.data.expires_at,/T.*Z$/);assert.equal((await req(s,'DELETE',`/api/admin/invites/${inv.data.id}`,{},a.cookie)).status,200);
 assert.equal((await req(s,'POST','/api/auth/invite-info',{invite_token:inv.data.invite_token})).data.valid,false);
 assert.equal((await req(s,'POST','/api/auth/join',{invite_token:inv.data.invite_token,name:'X',phone:'01012345678',username:'revoked_member',password:PASSWORD})).status,403);
 const exp=await req(s,'POST','/api/admin/invites',{},a.cookie);s.sqlite.prepare("UPDATE invites SET expires_at=datetime('now','-1 second') WHERE id=?").run(exp.data.id);
 assert.equal((await req(s,'POST','/api/auth/join',{invite_token:exp.data.invite_token,name:'X',phone:'01012345678',username:'expired_member',password:PASSWORD})).status,403);
 const changed=await req(s,'POST','/api/auth/change-password',{current_password:PASSWORD,new_password:NEXT_PASSWORD},a.cookie);assert.equal(changed.status,200);assert.ok(changed.cookie);assert.notEqual(changed.cookie,a.cookie);
 assert.equal((await req(s,'GET','/api/admin/users',undefined,a.cookie)).status,401);assert.equal((await req(s,'GET','/api/admin/users',undefined,changed.cookie)).status,200);
 const audit=JSON.stringify((await req(s,'GET','/api/admin/audit',undefined,changed.cookie)).data);for(const secret of [PASSWORD,NEXT_PASSWORD,inv.data.invite_token,exp.data.invite_token])assert.ok(!audit.includes(secret));
 s.sqlite.exec("UPDATE sessions SET expires_at=datetime('now','-1 second')");assert.equal((await req(s,'GET','/api/admin/users',undefined,changed.cookie)).status,401);
}finally{s.close();}});

test('customer cancel cutoff, historical memo corrections, reschedule window and normalized owner are enforced',async()=>{const s=setup();try{
 const a=await boot(s),u=await member(s,a);await approve(s,a,u);const date=dateAhead(),b=await book(s,u,'09:00',date);
 const settings=(await req(s,'GET','/api/admin/settings',undefined,a.cookie)).data;settings.settings.cancel_before_minutes=10080;assert.equal((await req(s,'PUT','/api/admin/settings',settings,a.cookie)).status,200);
 assert.equal((await req(s,'POST',`/api/bookings/${b.data.booking.id}/cancel`,{version:1},u.cookie)).status,409);
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,memo:'too late'},u.cookie)).status,409);
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,date:'2020-01-01'},a.cookie)).status,409);
 const manual=await book(s,a,'10:00',date,{customer_name:'전화 손님',phone:'01099998888'});assert.equal(manual.data.booking.user_id,null);
 const future=await book(s,a,'11:00',addDays(todayForTest(),60));assert.equal(future.status,409);
 // Seed an historical record by advancing a permitted booking backwards with guards explicitly removed only in this fixture.
 s.sqlite.exec('DROP TRIGGER booking_guard_update');s.sqlite.prepare('UPDATE bookings SET date=?,version=version+1 WHERE id=?').run('2020-01-01',b.data.booking.id);
 const edit=await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:2,memo:'과거 정정'},a.cookie);assert.equal(edit.status,200);assert.equal(edit.data.booking.date,'2020-01-01');
}finally{s.close();}});
function todayForTest(){return new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
function addDays(date,n){return new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}

test('API rejects malformed JSON, untrusted Fetch Metadata, oversized body and missing DB cleanly',async()=>{const s=setup();try{
 const a=await boot(s);assert.equal((await req(s,'POST','/api/bookings',{date:dateAhead(),start_time:'09:00'},a.cookie,{'Sec-Fetch-Site':'same-site'})).status,403);
 const malformed=await handleApi(new Request('https://example.test/api/auth/login',{method:'POST',headers:{'X-JinSling-Request':'1','Content-Type':'application/json'},body:'{'}),s.env);assert.equal(malformed.status,400);
 const huge=await req(s,'POST','/api/auth/login',{login_key:'a'.repeat(20000)});assert.equal(huge.status,413);
 const unavailable=await handleApi(new Request('https://example.test/api/session'),{});assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).error.code,'not_configured');
 assert.equal((await req(s,'GET','/api/bookings?from=2020-01-01&to=2026-10-30',undefined,a.cookie)).status,400);
}finally{s.close();}});

test('direct SQL cannot bypass booking guards, and audit failure rolls back booking mutation',async()=>{const s=setup();try{
 const a=await boot(s),b=await book(s,a);const n=s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 const insert=s.sqlite.prepare("INSERT INTO bookings(id,user_id,customer_name,phone,date,start_min,end_min,start_time,end_time,status,updated_by) VALUES (?,?,'raw','01012345678',?,?,?,?,?,'confirmed',?)");
 for(const [date,start,end,start_time,end_time] of [[dateAhead(),540,570,'09:00','09:30'],[dateAhead(0),540,570,'09:00','09:30'],[dateAhead(2),555,585,'09:15','09:45'],[dateAhead(2),1200,1230,'20:00','20:30'],['2026-02-30',540,570,'09:00','09:30']])assert.throws(()=>insert.run(crypto.randomUUID(),a.data.user.id,date,start,end,start_time,end_time,a.data.user.id));
 assert.equal(s.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,n);
 s.sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END;");
 assert.equal((await req(s,'PATCH',`/api/bookings/${b.data.booking.id}`,{version:1,memo:'must rollback'},a.cookie)).status,500);assert.equal(s.sqlite.prepare('SELECT memo FROM bookings WHERE id=?').get(b.data.booking.id).memo,'테스트');assert.equal(s.sqlite.prepare('SELECT version FROM bookings WHERE id=?').get(b.data.booking.id).version,1);
}finally{s.close();}});

test('offline sole-admin recovery invalidates sessions, preserves bookings and audits without secrets',async()=>{const s=setup(),dir=mkdtempSync(join(tmpdir(),'jinsling-recovery-'));try{
 const {generateRecoveryKey}=await import('../scripts/generate-recovery-key.mjs');
 const a=await boot(s),booking=await book(s,a);const before=s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(booking.data.booking.id);
 const paths=generateRecoveryKey({directory:dir});const newToken=readFileSync(paths.keyPath,'utf8').trim(),sql=readFileSync(paths.sqlPath,'utf8');assert.match(newToken,/^[A-Za-z0-9_-]{43}$/);assert.ok(!sql.includes(newToken));assert.equal(statSync(paths.keyPath).mode&0o777,0o600);assert.equal(statSync(paths.sqlPath).mode&0o777,0o600);
 assert.throws(()=>generateRecoveryKey({directory:dir}));assert.equal(readFileSync(paths.keyPath,'utf8').trim(),newToken);
 s.sqlite.exec(sql);assert.equal((await req(s,'GET','/api/admin/users',undefined,a.cookie)).status,401);assert.equal((await req(s,'POST','/api/auth/login',{username:'shop_owner',password:PASSWORD})).status,403);assert.equal((await req(s,'POST','/api/auth/login',{login_key:newToken})).status,401);
 const recovered=await req(s,'POST','/api/auth/reset-password',{reset_token:newToken,new_password:NEXT_PASSWORD});assert.equal(recovered.status,200);assert.equal(recovered.data.user.id,a.data.user.id);assert.deepEqual(s.sqlite.prepare('SELECT * FROM bookings WHERE id=?').get(booking.data.booking.id),before);
 const audit=(await req(s,'GET','/api/admin/audit',undefined,recovered.cookie)).data.items;assert.equal(audit[0].entity_type,'user');assert.equal(audit[0].entity_id,a.data.user.id);assert.equal(audit[0].actor_name,a.data.user.name);assert.ok(!JSON.stringify(audit).includes(newToken));assert.ok(!JSON.stringify(audit).includes(PASSWORD));
}finally{s.close();rmSync(dir,{recursive:true,force:true});}});
