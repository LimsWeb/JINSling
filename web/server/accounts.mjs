import { fail, defaults, publicUser, utc, token, hash, uuid, cookie, text, phone, only, username, password, json } from './support.mjs';
import { createPasswordAuth, passwordAuthReady, bootstrapAuthDiagnostic } from './password-provider.mjs';

export { passwordAuthReady };
const active = "status IN('pending','approved')";
const query = db => {
 const stmt=(sql,...args)=>db.prepare(sql).bind(...args);
 return {stmt,first:(sql,...args)=>stmt(sql,...args).first(),run:(sql,...args)=>stmt(sql,...args).run()};
};
function providerError(error,setup=false){
 const detail=setup?bootstrapAuthDiagnostic(error):'',suffix=detail?' '+detail:'';
 if(error?.code==='INVALID_CREDENTIALS')fail(401,'unauthorized','아이디와 비밀번호를 확인해 주세요.'+suffix);
 if(error?.code==='USERNAME_TAKEN')fail(409,'username_taken','이미 사용 중인 아이디입니다.'+suffix);
 if(error?.code==='NOT_CONFIGURED')fail(503,'auth_not_configured','비밀번호 인증 연결을 설정해 주세요.'+suffix);
 if(detail)fail(503,'auth_unavailable','관리자 등록을 완료하지 못했어요. 진단 코드를 확인해 주세요.'+suffix);
 fail(503,'auth_unavailable','비밀번호 인증을 완료하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 복구를 요청해 주세요.');
}
function provider(env){try{return createPasswordAuth(env);}catch(error){providerError(error);}}
async function external(auth,method,input,setup=false){try{return await auth[method](input);}catch(error){providerError(error,setup);}}
function principal(result){if(!result||typeof result.uid!=='string'||!result.uid||result.uid.length>128)providerError(null);return result.uid;}
const resetDigest=async value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)?hash(value):null;
function blocked(user){if(user.password_reset_required||user.credential_lock)fail(403,'password_reset_required','비밀번호 재설정이 필요합니다. 관리자에게 받은 링크 또는 소유자 복구 절차를 사용해 주세요.');}

export async function accountSession(request,db){
 const match=/(?:^|;)[ \t]*__Host-jinsling_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('Cookie')||'');
 if(!match)return {user:null,sessionHash:null};
 const sessionHash=await hash(match[1]);
 const user=await db.prepare("SELECT u.*,s.scope AS session_scope FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now') AND u.status IN('pending','approved') AND s.credential_revision=u.credential_revision AND u.password_reset_required=0 AND u.credential_lock IS NULL AND ((s.scope='full' AND u.provider_uid IS NOT NULL) OR (s.scope='legacy' AND u.provider_uid IS NULL AND u.username IS NULL))").bind(sessionHash).first();
 return {user,sessionHash};
}
function sessionInsert(stmt,digest,id,revision,scope,uid,keyHash=null){
 return stmt(`INSERT INTO sessions(token_hash,user_id,expires_at,credential_revision,scope) SELECT ?,id,datetime('now','+30 days'),credential_revision,? FROM users WHERE id=? AND credential_revision=? AND ${active} AND credential_lock IS NULL AND password_reset_required=0 AND ${scope==='legacy'?'provider_uid IS NULL AND username IS NULL AND key_hash=?':'provider_uid=?'}`,digest,scope,id,revision,scope==='legacy'?keyHash:uid);
}
async function newSession(db,user,scope='full'){
 const {stmt}=query(db),secret=token();
 const result=await sessionInsert(stmt,await hash(secret),user.id,user.credential_revision,scope,user.provider_uid,user.key_hash).run();
 if(result.meta.changes!==1)fail(401,'unauthorized','계정 상태가 변경되었습니다. 다시 로그인해 주세요.');
 return cookie(secret);
}
async function cleanupCreated(db,auth,uid){
 // A failed D1 response can represent a committed write. Never delete a linked
 // provider identity; if the database cannot be checked, leave it for the owner.
 try{if(await query(db).first('SELECT id FROM users WHERE provider_uid=?',uid))return false;await auth.deleteUser({uid});return true;}catch{return false;}
}
async function acquire(db,user,sessionHash,{resetHash=null}={}){
 const lock=token(),{run}=query(db);
 const condition=resetHash?"password_reset_required=1 AND reset_token_hash=? AND reset_expires_at>datetime('now')":"password_reset_required=0 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND user_id=users.id AND credential_revision=users.credential_revision AND expires_at>datetime('now'))";
 const result=await run(`UPDATE users SET credential_lock=?,credential_lock_started_at=datetime('now'),password_reset_required=1,credential_revision=credential_revision+1,updated_by=id WHERE id=? AND credential_revision=? AND credential_lock IS NULL AND ${active} AND ${condition}`,lock,user.id,user.credential_revision,resetHash??sessionHash);
 if(result.meta.changes!==1)fail(409,'account_busy','계정 상태가 변경되었거나 비밀번호 처리가 진행 중입니다. 새로 확인해 주세요.');
 return {lock,revision:user.credential_revision+1};
}
async function finish(db,user,operation,{username:chosenUsername=user.username,uid=user.provider_uid,convert=false}={}){
 const {stmt,first,run}=query(db),secret=token(),identity=convert?'username=?,provider_uid=?,key_hash=?,':'';
 const identityArgs=convert?[chosenUsername,uid,await hash(token())]:[];
 // This batch is atomic only in D1. Provider completion already happened. A D1
 // error leaves the previously committed lock/reset requirement in place.
 const result=await db.batch([
  stmt(`UPDATE users SET ${identity}password_reset_required=0,reset_token_hash=NULL,reset_expires_at=NULL,credential_lock=NULL,credential_lock_started_at=NULL,updated_by=id WHERE id=? AND credential_lock=? AND credential_revision=? AND ${active}`,...identityArgs,user.id,operation.lock,operation.revision),
  sessionInsert(stmt,await hash(secret),user.id,operation.revision,'full',uid)
 ]);
 if(result[0].meta.changes!==1||result[1].meta.changes!==1){
  // The provider call is known to have finished, but a suspension changed the
  // revision. Release only our own lock, retaining the reset requirement.
  await run('UPDATE users SET credential_lock=NULL,credential_lock_started_at=NULL WHERE id=? AND credential_lock=?',user.id,operation.lock);
  fail(401,'unauthorized','계정 상태가 변경되었습니다. 관리자에게 확인해 주세요.');
 }
 return json({user:publicUser(await first('SELECT * FROM users WHERE id=?',user.id))},{'Set-Cookie':cookie(secret)});
}

export async function accountRoutes({method,path,body,env,db,user,sessionHash,settingsRow}){
 const {stmt,first,run}=query(db);
 if(method!=='POST')return null;
 if(path==='/api/bootstrap'){
  only(body,['setup_token','name','phone','username','password']);
  if(typeof env.BOOTSTRAP_TOKEN!=='string'||!env.BOOTSTRAP_TOKEN||typeof body.setup_token!=='string'||body.setup_token.length>512)fail(403,'setup_denied','초기 설정을 확인해 주세요.');
  if(await hash(body.setup_token)!==await hash(env.BOOTSTRAP_TOKEN))fail(403,'setup_denied','초기 설정을 확인해 주세요.');
  if(settingsRow)fail(409,'already_configured','이미 초기 설정이 완료되었습니다.');
  const chosenUsername=username(body.username),chosenPassword=password(body.password),name=text(body.name,'이름',80),tel=phone(body.phone),id=uuid(),auth=provider(env);
  const uid=principal(await external(auth,'createUser',{username:chosenUsername,password:chosenPassword},true)),secret=token();
  try{
   const statements=[stmt('INSERT INTO settings(id,shop_name,contact_phone,booking_window_days,cancel_before_minutes,pilot_member_limit,member_limit,registration_open,updated_by) VALUES (1,?,?,30,0,100,100,1,?)',defaults.shop_name,'',id),stmt("INSERT INTO users(id,username,provider_uid,name,phone,role,status,key_hash,updated_by) VALUES (?,?,?,?,?,'admin','approved',?,?)",id,chosenUsername,uid,name,tel,await hash(token()),id)];
   for(let weekday=0;weekday<7;weekday++)statements.push(stmt("INSERT INTO weekly_rules(weekday,closed,open_time,close_time,open_min,close_min,daily_limit,updated_by) VALUES (?,?,'09:00',?,540,?,?,?)",weekday,weekday===0?1:0,weekday===6?'14:00':'20:00',weekday===6?840:1200,weekday===6?10:18,id));
   statements.push(sessionInsert(stmt,await hash(secret),id,0,'full',uid));await db.batch(statements);
  }catch(error){await cleanupCreated(db,auth,uid);throw error;}
  return json({user:publicUser(await first('SELECT * FROM users WHERE id=?',id))},{'Set-Cookie':cookie(secret)});
 }
 if(path==='/api/auth/login'){
  if(Object.hasOwn(body,'login_key')){
   only(body,['login_key']);const key=text(body.login_key,'기존 접속키',256);
   const found=await first(`SELECT * FROM users WHERE key_hash=? AND provider_uid IS NULL AND username IS NULL AND ${active}`,await hash(key));
   if(!found)fail(401,'unauthorized','기존 접속키를 확인해 주세요.');blocked(found);
   return json({user:publicUser(found)},{'Set-Cookie':await newSession(db,found,'legacy')});
  }
  only(body,['username','password']);const chosenUsername=username(body.username),chosenPassword=password(body.password),auth=provider(env);
  const found=await first(`SELECT * FROM users WHERE username=? AND provider_uid IS NOT NULL AND ${active}`,chosenUsername);
  if(!found)fail(401,'unauthorized','아이디와 비밀번호를 확인해 주세요.');blocked(found);
  const uid=principal(await external(auth,'verifyPassword',{username:chosenUsername,password:chosenPassword}));
  if(uid!==found.provider_uid)fail(401,'unauthorized','아이디와 비밀번호를 확인해 주세요.');
  return json({user:publicUser(found)},{'Set-Cookie':await newSession(db,found)});
 }
 if(path==='/api/auth/logout'){only(body,[]);if(sessionHash)await run('DELETE FROM sessions WHERE token_hash=?',sessionHash);return json({},{'Set-Cookie':cookie('')});}
 if(path==='/api/auth/invite-info'){
  only(body,['invite_token']);const invite=await first("SELECT expires_at FROM invites WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now')",await hash(text(body.invite_token,'초대',256)));
  return json({valid:!!invite,expires_at:utc(invite?.expires_at)});
 }
 if(path==='/api/auth/join'){
  only(body,['invite_token','name','phone','username','password']);
  const chosenUsername=username(body.username),chosenPassword=password(body.password),name=text(body.name,'이름',80),tel=phone(body.phone);
  if(!settingsRow)fail(409,'not_configured','상점 초기 설정이 필요합니다.');
  if(!settingsRow.registration_open)fail(403,'registration_closed','신규 회원 가입이 잠시 닫혀 있습니다.');
  if((await first('SELECT count(*) AS n FROM users')).n>=settingsRow.member_limit)fail(409,'member_limit','설정된 회원 수 한도에 도달했습니다.');
  if(await first('SELECT id FROM users WHERE username=?',chosenUsername))fail(409,'username_taken','이미 사용 중인 아이디입니다.');
  let invite=null;if(body.invite_token!==undefined){invite=await first("SELECT id FROM invites WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>datetime('now')",await hash(text(body.invite_token,'초대',256)));if(!invite)fail(403,'invalid_invite','유효하지 않거나 만료된 초대입니다.');}
  const auth=provider(env),uid=principal(await external(auth,'createUser',{username:chosenUsername,password:chosenPassword})),id=uuid(),secret=token();
  try{await db.batch([stmt("INSERT INTO users(id,username,provider_uid,name,phone,role,status,key_hash,invite_id,updated_by) VALUES (?,?,?,?,?,'user','pending',?,?,?)",id,chosenUsername,uid,name,tel,await hash(token()),invite?.id??null,id),sessionInsert(stmt,await hash(secret),id,0,'full',uid)]);}catch(error){await cleanupCreated(db,auth,uid);throw error;}
  return json({user:publicUser(await first('SELECT * FROM users WHERE id=?',id))},{'Set-Cookie':cookie(secret)});
 }
 if(path==='/api/auth/setup-password'){
  only(body,['username','password']);if(!user)fail(401,'unauthorized','기존 접속키로 먼저 로그인해 주세요.');
  if(user.provider_uid||user.session_scope!=='legacy')fail(409,'already_converted','이미 비밀번호 설정이 완료되었습니다.');
  const chosenUsername=username(body.username),chosenPassword=password(body.password),auth=provider(env);
  if(await first('SELECT id FROM users WHERE username=?',chosenUsername))fail(409,'username_taken','이미 사용 중인 아이디입니다.');
  const operation=await acquire(db,user,sessionHash);let uid;
  try{uid=principal(await external(auth,'createUser',{username:chosenUsername,password:chosenPassword}));}
  catch(error){
   // A definite duplicate did not mutate a provider account. The old key can be
   // used to log in again. Unknown outcomes retain the recovery lock.
   if(error.code==='username_taken')await run('UPDATE users SET credential_lock=NULL,credential_lock_started_at=NULL,password_reset_required=0 WHERE id=? AND credential_lock=?',user.id,operation.lock);
   throw error;
  }
  try{return await finish(db,user,operation,{username:chosenUsername,uid,convert:true});}
  catch(error){
   if(await cleanupCreated(db,auth,uid))await run('UPDATE users SET credential_lock=NULL,credential_lock_started_at=NULL,password_reset_required=0 WHERE id=? AND credential_lock=? AND provider_uid IS NULL',user.id,operation.lock);
   throw error;
  }
 }
 if(path==='/api/auth/change-password'){
  only(body,['current_password','new_password']);if(!user)fail(401,'unauthorized','로그인해 주세요.');
  if(!user.provider_uid)fail(403,'password_setup_required','먼저 아이디와 비밀번호를 설정해 주세요.');
  const current=password(body.current_password),next=password(body.new_password),auth=provider(env);
  if(principal(await external(auth,'verifyPassword',{username:user.username,password:current}))!==user.provider_uid)fail(401,'unauthorized','현재 비밀번호를 확인해 주세요.');
  const operation=await acquire(db,user,sessionHash);
  await external(auth,'setPassword',{uid:user.provider_uid,password:next});
  return finish(db,user,operation);
 }
 if(path==='/api/auth/reset-info'){
  only(body,['reset_token']);const digest=await resetDigest(body.reset_token),found=digest?await first(`SELECT reset_expires_at FROM users WHERE reset_token_hash=? AND reset_expires_at>datetime('now') AND password_reset_required=1 AND credential_lock IS NULL AND provider_uid IS NOT NULL AND ${active}`,digest):null;
  return json({valid:!!found,expires_at:utc(found?.reset_expires_at)});
 }
 if(path==='/api/auth/reset-password'){
  only(body,['reset_token','new_password']);const digest=await resetDigest(body.reset_token),next=password(body.new_password);
  const found=digest?await first(`SELECT * FROM users WHERE reset_token_hash=? AND reset_expires_at>datetime('now') AND password_reset_required=1 AND provider_uid IS NOT NULL AND ${active}`,digest):null;
  if(!found)fail(403,'invalid_reset','유효하지 않거나 만료된 재설정 링크입니다.');
  const auth=provider(env),operation=await acquire(db,found,null,{resetHash:digest});
  await external(auth,'setPassword',{uid:found.provider_uid,password:next});
  return finish(db,found,operation);
 }
 return null;
}

export async function issuePasswordReset(db,target,actorId){
 if(!target.provider_uid)fail(409,'password_setup_required','기존 접속키로 로그인하여 먼저 비밀번호를 설정해 주세요.');
 const {run,first}=query(db),secret=token(),digest=await hash(secret);
 const result=await run("UPDATE users SET reset_token_hash=?,reset_expires_at=datetime('now','+24 hours'),password_reset_required=1,credential_revision=credential_revision+1,updated_by=? WHERE id=? AND credential_lock IS NULL",digest,actorId,target.id);
 if(result.meta.changes!==1)fail(409,'account_busy','비밀번호 변경이 진행 중이거나 소유자 복구가 필요합니다.');
 const row=await first('SELECT reset_expires_at FROM users WHERE id=? AND reset_token_hash=?',target.id,digest);
 if(!row)fail(409,'account_busy','더 새로운 재설정 요청이 있습니다. 다시 확인해 주세요.');
 return json({reset_token:secret,expires_at:utc(row.reset_expires_at)});
}
