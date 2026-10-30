import {ApiError,fail,defaults,publicUser,publicBooking,publicSettings,publicRule,publicBlock,publicTimestamps,utc,token,hash,uuid,cookie,today,seoulNow,addDays,text,phone,integer,validDate,minute,time,version,only,readJson,securityHeaders,json,errorResponse,sqlError,csvResponse} from './support.mjs';
import {accountSession,accountRoutes,issuePasswordReset,passwordAuthReady} from './accounts.mjs';

export async function handleApi(request,env,ctx={}) {
 try{return await route(request,env);}catch(error){try{sqlError(error);}catch(mapped){return errorResponse(mapped);}return errorResponse(error);}
}
async function route(request,env){
 if(!env?.DB)fail(503,'not_configured','데이터베이스 연결을 설정해 주세요.');
 const db=env.DB,url=new URL(request.url),path=url.pathname,method=request.method;
 const stmt=(sql,...args)=>db.prepare(sql).bind(...args),first=(sql,...args)=>stmt(sql,...args).first(),all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
 const run=(sql,...args)=>stmt(sql,...args).run();
 const body=['POST','PUT','PATCH','DELETE'].includes(method)?await readJson(request):undefined;
 const settingsRow=await first('SELECT * FROM settings WHERE id=1'),settings=settingsRow?publicSettings(settingsRow):defaults;
 const {user,sessionHash}=await accountSession(request,db);
 const auth=()=>{if(!user)fail(401,'unauthorized','아이디와 비밀번호로 로그인해 주세요.');if(!user.provider_uid)fail(403,'password_setup_required','먼저 아이디와 비밀번호를 설정해 주세요.');if(user.status!=='approved')fail(403,'pending_approval','관리자 승인을 기다리고 있습니다.');return user;};
 const admin=()=>{auth();if(user.role!=='admin')fail(403,'forbidden','관리자 권한이 필요합니다.');};
 if(method==='GET'&&path==='/api/session')return json({configured:!!settingsRow,auth_ready:passwordAuthReady(env),user:publicUser(user),settings});
 if(method==='POST'&&(path.startsWith('/api/auth/')||path==='/api/bootstrap')){
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';const bucket=await hash(path+'|'+ip),window=Math.floor(Date.now()/900000);
  await run('DELETE FROM rate_limits WHERE window<?',window-2);
  await run('INSERT INTO rate_limits(bucket,window,attempts) VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END,window=excluded.window',bucket,window);
  if((await first('SELECT attempts FROM rate_limits WHERE bucket=?',bucket)).attempts>10)fail(429,'rate_limited','잠시 후 다시 시도해 주세요.');
 }
 const accountResponse=await accountRoutes({method,path,body,env,db,user,sessionHash,settingsRow});if(accountResponse)return accountResponse;
 if(path.startsWith('/api/admin/'))admin();else auth();
 const range=()=>{const from=validDate(url.searchParams.get('from')||today()),to=validDate(url.searchParams.get('to')||addDays(from,settings.booking_window_days));if(to<from||Date.parse(to)-Date.parse(from)>366*86400000)fail(400,'invalid_input','조회 기간을 확인해 주세요.');return [from,to];};
 const rules=()=>all('SELECT * FROM weekly_rules ORDER BY weekday');
 const bookingById=async id=>{const b=await first('SELECT * FROM bookings WHERE id=?',id);if(!b||(user.role!=='admin'&&b.user_id!==user.id))fail(404,'not_found','예약을 찾을 수 없습니다.');return b;};
 const cutoff=b=>{if(user.role!=='admin'&&Date.parse(`${b.date}T${b.start_time}:00+09:00`)-settings.cancel_before_minutes*60000<=Date.now())fail(409,'cutoff','예약 변경 및 취소 가능 시간이 지났습니다.');};
 if(method==='GET'&&path==='/api/availability'){
  const date=validDate(url.searchParams.get('date')),weekday=new Date(date+'T00:00:00Z').getUTCDay(),rule=await first('SELECT * FROM weekly_rules WHERE weekday=?',weekday);
  const bookings=await all("SELECT start_min,end_min FROM bookings WHERE date=? AND status='confirmed'",date),blocks=await all('SELECT start_min,end_min FROM blocks WHERE date=? AND deleted_at IS NULL',date);
  const closed=!!rule.closed||date<today()||date>addDays(today(),settings.booking_window_days),reason=rule.closed?'휴무일입니다.':closed?'예약 가능 기간이 아닙니다.':bookings.length>=rule.daily_limit?'일일 예약 한도에 도달했습니다.':'';const slots=[];
  if(!closed)for(let n=rule.open_min;n+30<=rule.close_min;n+=30)slots.push({start_time:time(n),end_time:time(n+30),available:date+' '+time(n)>seoulNow()&&bookings.length<rule.daily_limit&&![...bookings,...blocks].some(x=>x.start_min<n+30&&x.end_min>n)});
  return json({date,slots,booked_count:bookings.length,daily_limit:rule.daily_limit,closed,reason});
 }
 if(method==='GET'&&path==='/api/bookings'){const [from,to]=range();return json({items:(await all(`SELECT * FROM bookings WHERE date BETWEEN ? AND ? ${user.role==='admin'?'':'AND user_id=?'} ORDER BY date,start_min,created_at`,from,to,...(user.role==='admin'?[]:[user.id]))).map(publicBooking)});}
 if(method==='POST'&&path==='/api/bookings'){
  only(body,['date','start_time','memo','customer_name','phone','user_id','request_id']);const date=validDate(body.date),start=minute(body.start_time),memo=text(body.memo??'','메모',1000,{empty:true});
  if(user.role!=='admin'&&['customer_name','phone','user_id'].some(k=>Object.hasOwn(body,k)))fail(403,'forbidden','본인 예약만 등록할 수 있습니다.');
  let owner=user;if(user.role==='admin'&&Object.hasOwn(body,'user_id')){owner=body.user_id===null?null:await first('SELECT * FROM users WHERE id=?',text(body.user_id,'회원',80));if(body.user_id!==null&&!owner)fail(400,'invalid_input','회원을 확인해 주세요.');}else if(user.role==='admin'&&(body.customer_name!==undefined||body.phone!==undefined))owner=null;
  const name=text(body.customer_name??owner?.name,'이름',80),tel=phone(body.phone??owner?.phone);let requestId=null;if(body.request_id!==undefined){if(typeof body.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id))fail(400,'invalid_input','요청 번호를 확인해 주세요.');requestId=body.request_id.toLowerCase();}
  const payload=await hash(JSON.stringify({date,start_time:time(start),memo,customer_name:name,phone:tel,user_id:owner?.id??null}));
  const prior=async()=>requestId?await first('SELECT * FROM bookings WHERE request_actor=? AND request_id=?',user.id,requestId):null;
  let existing=await prior();if(existing){if(existing.request_payload!==payload)fail(409,'idempotency_conflict','같은 요청 번호의 내용이 다릅니다.');return json({booking:publicBooking(existing)});}
  const id=uuid();try{await run("INSERT INTO bookings(id,user_id,customer_name,phone,date,start_min,end_min,start_time,end_time,memo,status,version,updated_by,request_id,request_actor,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed',1,?,?,?,?)",id,owner?.id??null,name,tel,date,start,start+30,time(start),time(start+30),memo,user.id,requestId,user.id,payload);}catch(error){existing=await prior();if(!existing||existing.request_payload!==payload)throw error;return json({booking:publicBooking(existing)});}
  return json({booking:publicBooking(await first('SELECT * FROM bookings WHERE id=?',id))});
 }
 let routeMatch=/^\/api\/bookings\/([^/]+)(\/cancel)?$/.exec(path);
 if(routeMatch&&((method==='PATCH'&&!routeMatch[2])||(method==='POST'&&routeMatch[2]))){
  const b=await bookingById(routeMatch[1]),v=version(body);if(v!==b.version)fail(409,'stale_version','예약이 변경되었습니다. 새로고침해 주세요.');if(b.status!=='confirmed')fail(409,'cancelled','이미 취소된 예약입니다.');cutoff(b);
  if(routeMatch[2]){only(body,['version','reason']);const reason=text(body.reason??'','취소 사유',500,{empty:true});const result=await run("UPDATE bookings SET status='cancelled',cancel_reason=?,version=version+1,updated_at=datetime('now'),updated_by=? WHERE id=? AND version=?",reason,user.id,b.id,v);if(!result.meta.changes)fail(409,'stale_version','예약이 변경되었습니다.');}
  else{
   only(body,['version','date','start_time','memo','customer_name','phone']);if(user.role!=='admin'&&Object.keys(body).some(k=>!['version','memo'].includes(k)))fail(403,'forbidden','메모만 수정할 수 있습니다.');
   const date=body.date===undefined?b.date:validDate(body.date),start=body.start_time===undefined?b.start_min:minute(body.start_time),memo=body.memo===undefined?b.memo:text(body.memo,'메모',1000,{empty:true}),name=body.customer_name===undefined?b.customer_name:text(body.customer_name,'이름',80),tel=body.phone===undefined?b.phone:phone(body.phone);
   const result=await run("UPDATE bookings SET date=?,start_min=?,end_min=?,start_time=?,end_time=?,memo=?,customer_name=?,phone=?,version=version+1,updated_at=datetime('now'),updated_by=? WHERE id=? AND version=?",date,start,start+30,time(start),time(start+30),memo,name,tel,user.id,b.id,v);if(!result.meta.changes)fail(409,'stale_version','예약이 변경되었습니다.');
  }
  return json({booking:publicBooking(await first('SELECT * FROM bookings WHERE id=?',b.id))});
 }
 if(method==='GET'&&path==='/api/admin/users')return json({items:(await all('SELECT * FROM users ORDER BY created_at,id')).map(publicUser)});
 if(method==='GET'&&path==='/api/admin/members.csv')return csvResponse((await all('SELECT * FROM users ORDER BY created_at,id')).map(publicUser),['name','phone','username','status','created_at','password_reset_required'],'jinsling-members.csv');
 routeMatch=/^\/api\/admin\/users\/([^/]+)(\/reset-password)?$/.exec(path);
 if(routeMatch&&((method==='PATCH'&&!routeMatch[2])||(method==='POST'&&routeMatch[2]))){
  const target=await first('SELECT * FROM users WHERE id=?',routeMatch[1]);if(!target)fail(404,'not_found','회원을 찾을 수 없습니다.');
  if(routeMatch[2]){only(body,[]);return issuePasswordReset(db,target,user.id);}
  only(body,['status']);if(!['pending','approved','suspended','rejected'].includes(body.status))fail(400,'invalid_input','회원 상태를 확인해 주세요.');if(target.role==='admin'&&body.status!=='approved')fail(409,'administrator_required','관리자 계정은 중지할 수 없습니다.');await run('UPDATE users SET status=?,updated_by=? WHERE id=?',body.status,user.id,target.id);return json({user:publicUser(await first('SELECT * FROM users WHERE id=?',target.id))});
 }
 if(method==='GET'&&path==='/api/admin/invites')return json({items:(await all('SELECT id,created_at,expires_at,used_at,revoked_at FROM invites ORDER BY created_at DESC,id')).map(publicTimestamps)});
 if(method==='POST'&&path==='/api/admin/invites'){only(body,[]);const id=uuid(),secret=token();await run("INSERT INTO invites(id,token_hash,expires_at,created_by) VALUES (?,?,datetime('now','+7 days'),?)",id,await hash(secret),user.id);return json({id,invite_token:secret,expires_at:utc((await first('SELECT expires_at FROM invites WHERE id=?',id)).expires_at)});}
 routeMatch=/^\/api\/admin\/invites\/([^/]+)$/.exec(path);
 if(method==='DELETE'&&routeMatch){only(body,[]);const result=await run("UPDATE invites SET revoked_at=datetime('now'),revoked_by=? WHERE id=? AND revoked_at IS NULL",user.id,routeMatch[1]);if(!result.meta.changes)fail(404,'not_found','초대를 찾을 수 없습니다.');return json({});}
 if(method==='GET'&&path==='/api/admin/settings')return json({settings,weekly_rules:(await rules()).map(publicRule)});
 if(method==='PUT'&&path==='/api/admin/settings'){
  only(body,['settings','weekly_rules']);if(!body.settings||typeof body.settings!=='object'||Array.isArray(body.settings))fail(400,'invalid_input','설정을 확인해 주세요.');only(body.settings,Object.keys(defaults));const s=body.settings;
  const shop=text(s.shop_name,'상호',80),tel=phone(s.contact_phone,{empty:true}),window=integer(s.booking_window_days,1,90),cancel=integer(s.cancel_before_minutes,0,10080),limit=integer(s.member_limit,1,1000);if(typeof s.registration_open!=='boolean')fail(400,'invalid_input','가입 허용 설정을 확인해 주세요.');
  if(!Array.isArray(body.weekly_rules)||body.weekly_rules.length!==7)fail(400,'invalid_input','일곱 요일 설정이 필요합니다.');const seen=new Set();const statements=[stmt('UPDATE settings SET shop_name=?,contact_phone=?,booking_window_days=?,cancel_before_minutes=?,member_limit=?,registration_open=?,updated_by=? WHERE id=1',shop,tel,window,cancel,limit,s.registration_open?1:0,user.id)];
  for(const r of body.weekly_rules){if(!r||typeof r!=='object'||Array.isArray(r))fail(400,'invalid_input','요일을 확인해 주세요.');only(r,['weekday','closed','open_time','close_time','daily_limit']);const weekday=integer(r.weekday,0,6),open=minute(r.open_time),close=minute(r.close_time,{end:true}),cap=integer(r.daily_limit,1,48);if(seen.has(weekday)||typeof r.closed!=='boolean'||open>=close)fail(400,'invalid_input','영업시간을 확인해 주세요.');seen.add(weekday);statements.push(stmt('UPDATE weekly_rules SET closed=?,open_time=?,close_time=?,open_min=?,close_min=?,daily_limit=?,updated_by=? WHERE weekday=?',r.closed?1:0,time(open),time(close),open,close,cap,user.id,weekday));}
  await db.batch(statements);return json({settings:publicSettings(await first('SELECT * FROM settings WHERE id=1')),weekly_rules:(await rules()).map(publicRule)});
 }
 if(method==='GET'&&path==='/api/admin/blocks'){const [from,to]=range();return json({items:(await all('SELECT * FROM blocks WHERE date BETWEEN ? AND ? AND deleted_at IS NULL ORDER BY date,start_min',from,to)).map(publicBlock)});}
 if(method==='POST'&&path==='/api/admin/blocks'){only(body,['date','start_time','end_time','note']);const date=validDate(body.date),start=minute(body.start_time),end=minute(body.end_time,{end:true}),note=text(body.note??'','메모',500,{empty:true});if(start>=end)fail(400,'invalid_input','차단 시간을 확인해 주세요.');const id=uuid();await run('INSERT INTO blocks(id,date,start_time,end_time,start_min,end_min,note,created_by) VALUES (?,?,?,?,?,?,?,?)',id,date,time(start),time(end),start,end,note,user.id);return json({block:publicBlock(await first('SELECT * FROM blocks WHERE id=?',id))});}
 routeMatch=/^\/api\/admin\/blocks\/([^/]+)$/.exec(path);
 if(method==='DELETE'&&routeMatch){only(body,[]);const result=await run("UPDATE blocks SET deleted_at=datetime('now'),deleted_by=? WHERE id=? AND deleted_at IS NULL",user.id,routeMatch[1]);if(!result.meta.changes)fail(404,'not_found','차단을 찾을 수 없습니다.');return json({});}
 if(method==='GET'&&path==='/api/admin/audit'){const limit=integer(Number(url.searchParams.get('limit')||100),1,500);return json({items:(await all('SELECT id,entity_type,entity_id,action,actor_name,created_at,before_data,after_data FROM audit_log ORDER BY id DESC LIMIT ?',limit)).map(publicTimestamps)});}
 if(method==='GET'&&path==='/api/admin/export.csv'){
  const [from,to]=range(),rows=(await all('SELECT * FROM bookings WHERE date BETWEEN ? AND ? ORDER BY date,start_min',from,to)).map(publicTimestamps),columns=['id','user_id','customer_name','phone','date','start_time','end_time','memo','status','version','created_at','updated_at'];
  const cell=value=>{let s=String(value??'');if(/^[\s\uFEFF]*[=+\-@]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const csv='\uFEFF'+[columns.map(cell).join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';
  return new Response(csv,{headers:{...securityHeaders,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="jinsling-${from}-${to}.csv"`}});
 }
 fail(404,'not_found','요청한 경로를 찾을 수 없습니다.');
}
