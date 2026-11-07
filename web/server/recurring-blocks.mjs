import {addDays,fail,hash,integer,minute,only,text,time,today,validDate,version,uuid} from './support.mjs';
import {RECURRENCE_SCHEMA,RECURRENCE_OBJECTS,RECURRENCE_MIGRATION,recurrenceMatchSql} from './recurring-schema.mjs';

const CONFIG_FIELDS=['frequency','start_date','end_date','weekdays','monthly_mode','month_day','month_week','month_weekday','start_time','end_time','note','enabled'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const first=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
function requestId(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'invalid_input','요청 번호를 확인해 주세요.');return value.toLowerCase();}
function ruleId(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'invalid_input','반복 잠금을 확인해 주세요.');return value.toLowerCase();}
const stale=()=>fail(409,'stale_version','반복 잠금이 변경되었어요. 새로고침한 뒤 다시 확인해 주세요.');

export async function recurrenceSchemaState(db){
 const found=await all(db,"SELECT type,name FROM sqlite_master WHERE name LIKE 'recurring_%'");
 const has=(type,name)=>found.some(row=>row.type===type&&row.name===name);
 return {ready:RECURRENCE_OBJECTS.every(row=>has(row.type,row.name)),present:RECURRENCE_OBJECTS.some(row=>has(row.type,row.name)),rules:has('table','recurring_blocks'),exceptions:has('table','recurring_block_exceptions')};
}
export async function assertRecurrenceReady(db){
 const state=await recurrenceSchemaState(db);
 if(state.present&&!state.ready)fail(503,'recurring_setup_required','반복 일정 설정을 확인하고 있어요. 매장 관리자에게 문의해 주세요.');
 return state;
}
export async function ensureRecurrenceSchema(db){
 const state=await recurrenceSchemaState(db);if(state.ready)return;
 // All objects are additive. A failure rolls back the entire installation. A
 // concurrent first save is safe because every CREATE and marker is idempotent.
 await db.batch([
  ...RECURRENCE_SCHEMA.map(sql=>db.prepare(sql)),
  db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'),
  db.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)').bind(RECURRENCE_MIGRATION)
 ]);
 if(!(await recurrenceSchemaState(db)).ready)fail(503,'recurring_setup_required','반복 일정 설정을 완료하지 못했어요. 다시 저장해 주세요.');
}

function normalize(body){
 const frequency=body.frequency;if(!['daily','weekly','biweekly','monthly'].includes(frequency))fail(400,'invalid_input','반복 주기를 선택해 주세요.');
 const start_date=validDate(body.start_date),end_date=body.end_date==null||body.end_date===''?null:validDate(body.end_date);
 if(end_date&&end_date<start_date)fail(400,'invalid_input','종료일은 시작일 이후로 선택해 주세요.');
 const start_min=minute(body.start_time),end_min=minute(body.end_time,{end:true});if(start_min>=end_min)fail(400,'invalid_input','시작 시간보다 늦은 종료 시간을 선택해 주세요. 자정을 넘기면 두 규칙으로 나눠 주세요.');
 const enabled=body.enabled===undefined?true:body.enabled;if(typeof enabled!=='boolean')fail(400,'invalid_input','반복 잠금 상태를 확인해 주세요.');
 let weekdays_mask=0,monthly_mode=null,month_day=null,month_week=null,month_weekday=null;
 if(frequency==='weekly'||frequency==='biweekly'){
  const days=body.weekdays;if(!Array.isArray(days)||days.length<1||days.length>7||new Set(days).size!==days.length)fail(400,'invalid_input','반복할 요일을 하나 이상 선택해 주세요.');
  for(const day of days)weekdays_mask|=1<<integer(day,0,6,'요일');
 }
 if(frequency==='monthly'){
  monthly_mode=body.monthly_mode;if(!['day','weekday'].includes(monthly_mode))fail(400,'invalid_input','매달 반복 기준을 선택해 주세요.');
  if(monthly_mode==='day')month_day=integer(body.month_day,1,31,'날짜');
  else{month_week=integer(body.month_week,-1,5,'주차');if(month_week===0)fail(400,'invalid_input','첫째~다섯째 또는 마지막 주를 선택해 주세요.');month_weekday=integer(body.month_weekday,0,6,'요일');}
 }
 return {frequency,start_date,end_date,weekdays_mask,monthly_mode,month_day,month_week,month_weekday,start_time:time(start_min),end_time:time(end_min),start_min,end_min,note:text(body.note??'','메모',500,{empty:true}),enabled:enabled?1:0};
}
function withinWindow(rule,existing=null){
 const current=today();
 if((rule.start_date<current&&rule.start_date!==existing?.start_date)||rule.start_date>addDays(current,365))fail(400,'invalid_input','새 시작일은 오늘부터 365일 이내로 선택해 주세요.');
}

// Date strings represent Seoul calendar dates, independent of browser/server TZ.
export function matchesRecurrence(rule,date){
 if(date<rule.start_date||(rule.end_date&&date>rule.end_date))return false;
 const current=new Date(`${date}T00:00:00Z`),weekday=current.getUTCDay(),day=current.getUTCDate();
 if(rule.frequency==='daily')return true;
 if(rule.frequency==='weekly'||rule.frequency==='biweekly'){
  const mask=rule.weekdays_mask??(rule.weekdays||[]).reduce((bits,value)=>bits|(1<<value),0);
  if(!(mask&(1<<weekday)))return false;if(rule.frequency==='weekly')return true;
  const start=new Date(`${rule.start_date}T00:00:00Z`),weekOffset=(start.getUTCDay()+6)%7;
  return Math.floor(((current-start)/86400000+weekOffset)/7)%2===0;
 }
 if(rule.frequency==='monthly'){
  if(rule.monthly_mode==='day')return day===rule.month_day;
  if(weekday!==rule.month_weekday)return false;
  if(rule.month_week===-1){const last=new Date(current);last.setUTCMonth(last.getUTCMonth()+1,0);return day+7>last.getUTCDate();}
  return Math.floor((day-1)/7)+1===rule.month_week;
 }
 return false;
}

function publicRule(row,exceptions=[]){
 return {id:row.id??null,frequency:row.frequency,start_date:row.start_date,end_date:row.end_date,weekdays:Array.from({length:7},(_,i)=>i).filter(i=>row.weekdays_mask&(1<<i)),monthly_mode:row.monthly_mode,month_day:row.month_day,month_week:row.month_week,month_weekday:row.month_weekday,start_time:row.start_time,end_time:row.end_time,note:row.note,enabled:!!row.enabled&&row.deleted_at==null,version:row.version??1,exceptions};
}
async function exceptionDates(db,id,state=null){
 if(state&&!state.exceptions)return [];
 return (await all(db,'SELECT date FROM recurring_block_exceptions WHERE rule_id=? AND active=1 AND date>=? ORDER BY date',id,today())).map(row=>row.date);
}
async function getRow(db,id,{includeDeleted=false}={}){
 const row=await first(db,`SELECT * FROM recurring_blocks WHERE id=? ${includeDeleted?'':'AND deleted_at IS NULL'}`,ruleId(id));
 if(!row)fail(404,'not_found','반복 잠금을 찾을 수 없어요.');return row;
}
async function readRule(db,id){const row=await getRow(db,id,{includeDeleted:true});return publicRule(row,await exceptionDates(db,row.id));}
export async function listRecurringBlocks(db){
 const state=await recurrenceSchemaState(db);if(!state.rules)return {items:[],schema_ready:false};
 const rows=await all(db,'SELECT * FROM recurring_blocks WHERE deleted_at IS NULL ORDER BY created_at,id');
 const dates=state.exceptions?await all(db,'SELECT rule_id,date FROM recurring_block_exceptions WHERE active=1 AND date>=? ORDER BY date',today()):[];
 return {items:rows.map(row=>publicRule(row,dates.filter(x=>x.rule_id===row.id).map(x=>x.date))),schema_ready:state.ready};
}

async function conflictingBookings(db,rule,id=null,{exceptions=true}={}){
 if(!rule.enabled)return {conflicts:[],conflict_count:0};
 const columns=Object.keys(rule),asRule=`(SELECT ${columns.map(key=>`? AS ${key}`).join(',')}) r`;
 const ignore=exceptions&&id?'AND NOT EXISTS(SELECT 1 FROM recurring_block_exceptions x WHERE x.rule_id=? AND x.date=b.date AND x.active=1)':'';
 const rows=await all(db,`SELECT b.date,b.start_time,b.end_time,COUNT(*) OVER () AS total FROM bookings b CROSS JOIN ${asRule}
 WHERE b.status='confirmed' AND b.date>=date('now','+9 hours') AND b.date||' '||b.end_time>strftime('%Y-%m-%d %H:%M','now','+9 hours')
 AND b.start_min<r.end_min AND b.end_min>r.start_min AND ${recurrenceMatchSql('r','b.date')} ${ignore}
 ORDER BY b.date,b.start_min,b.id LIMIT 20`,...columns.map(key=>rule[key]),...(ignore?[id]:[]));
 return {conflicts:rows.map(({date,start_time,end_time})=>({date,start_time,end_time})),conflict_count:Number(rows[0]?.total||0)};
}
function occurrences(rule,exceptions){
 if(!rule.enabled)return [];
 const from=rule.start_date>today()?rule.start_date:today(),last=addDays(from,732),until=rule.end_date&&rule.end_date<last?rule.end_date:last,result=[],excluded=new Set(exceptions);
 for(let date=from;date<=until&&result.length<8;date=addDays(date,1))if(matchesRecurrence(rule,date)&&!excluded.has(date))result.push({date,start_time:rule.start_time,end_time:rule.end_time});
 return result;
}
export async function previewRecurringBlock(db,body){
 only(body,[...CONFIG_FIELDS,'id','version','request_id']);if(body.request_id!==undefined)requestId(body.request_id);
 const state=await recurrenceSchemaState(db);let existing=null;
 if(body.id!==undefined){if(!state.rules)fail(404,'not_found','반복 잠금을 찾을 수 없어요.');existing=await getRow(db,body.id);if(version(body)!==existing.version)stale();}
 const rule=normalize(body);withinWindow(rule,existing);
 const dates=existing?await exceptionDates(db,existing.id,state):[],conflicts=await conflictingBookings(db,rule,existing?.id,{exceptions:state.exceptions});
 const capped=!existing&&state.rules&&(await first(db,'SELECT count(*) AS count FROM recurring_blocks WHERE deleted_at IS NULL')).count>=32;
 return {rule:publicRule({...rule,id:existing?.id,version:existing?.version},dates),occurrences:occurrences(rule,dates),...conflicts,can_save:!conflicts.conflict_count&&!capped};
}

export async function createRecurringBlock(db,body,actorId){
 only(body,[...CONFIG_FIELDS,'request_id']);const rule=normalize(body),request_id=requestId(body.request_id),payload=await hash(JSON.stringify({actor_id:actorId,...rule}));
 // Check request identity before date-window validation. A retry after midnight,
 // an edit, pause or deletion must never silently create a second routine.
 const state=await recurrenceSchemaState(db);
 const prior=async()=>first(db,'SELECT * FROM recurring_blocks WHERE request_id=?',request_id);
 const existingResult=async row=>{if(row.created_by!==actorId||row.request_payload!==payload)fail(409,'idempotency_conflict','같은 요청 번호의 내용이 달라요. 새 요청으로 확인해 주세요.');return {rule:await readRule(db,row.id)};};
 if(state.rules){const previous=await prior();if(previous){await ensureRecurrenceSchema(db);return existingResult(previous);}}
 withinWindow(rule);await ensureRecurrenceSchema(db);
 const id=uuid(),columns=Object.keys(rule);
 try{await db.prepare(`INSERT INTO recurring_blocks(id,${columns.join(',')},created_by,updated_by,request_id,request_payload) VALUES (${Array(columns.length+5).fill('?').join(',')})`).bind(id,...columns.map(key=>rule[key]),actorId,actorId,request_id,payload).run();}
 catch(error){const previous=await prior();if(previous)return existingResult(previous);throw error;}
 return {rule:await readRule(db,id)};
}
export async function updateRecurringBlock(db,id,body,actorId){
 only(body,[...CONFIG_FIELDS,'version']);const expected=version(body),rule=normalize(body);ruleId(id);await ensureRecurrenceSchema(db);
 const existing=await getRow(db,id);if(existing.version!==expected)stale();withinWindow(rule,existing);
 const columns=Object.keys(rule),result=await db.prepare(`UPDATE recurring_blocks SET ${columns.map(key=>`${key}=?`).join(',')},version=version+1,updated_by=?,updated_at=datetime('now') WHERE id=? AND version=? AND deleted_at IS NULL`).bind(...columns.map(key=>rule[key]),actorId,id,expected).run();
 if(!result.meta.changes)stale();return {rule:await readRule(db,id)};
}
export async function setRecurringEnabled(db,id,body,actorId){
 only(body,['enabled','version']);const expected=version(body);if(typeof body.enabled!=='boolean')fail(400,'invalid_input','반복 잠금 상태를 확인해 주세요.');ruleId(id);await ensureRecurrenceSchema(db);
 const existing=await getRow(db,id);if(existing.version!==expected)stale();
 const result=await db.prepare("UPDATE recurring_blocks SET enabled=?,version=version+1,updated_by=?,updated_at=datetime('now') WHERE id=? AND version=? AND deleted_at IS NULL").bind(body.enabled?1:0,actorId,id,expected).run();
 if(!result.meta.changes)stale();return {rule:await readRule(db,id)};
}
export async function deleteRecurringBlock(db,id,body,actorId){
 only(body,['version']);const expected=version(body);ruleId(id);await ensureRecurrenceSchema(db);
 const existing=await getRow(db,id);if(existing.version!==expected)stale();
 const result=await db.prepare("UPDATE recurring_blocks SET deleted_at=datetime('now'),version=version+1,updated_by=?,updated_at=datetime('now') WHERE id=? AND version=? AND deleted_at IS NULL").bind(actorId,id,expected).run();
 if(!result.meta.changes)stale();return {};
}
export async function setRecurringException(db,id,date,body,actorId,active){
 only(body,['version']);const expected=version(body);ruleId(id);validDate(date);await ensureRecurrenceSchema(db);
 const rule=await getRow(db,id);if(rule.version!==expected)stale();
 const prior=await first(db,'SELECT active FROM recurring_block_exceptions WHERE rule_id=? AND date=?',id,date);
 if(active){
  if(date<today()||date>addDays(today(),365)||!matchesRecurrence(rule,date))fail(400,'invalid_input','오늘부터 365일 이내에서 반복 잠금이 적용되는 날짜를 선택해 주세요.');
  if(!prior?.active)await db.prepare(`INSERT INTO recurring_block_exceptions(rule_id,date,active,rule_version,updated_by) VALUES (?,?,1,?,?)
   ON CONFLICT(rule_id,date) DO UPDATE SET active=1,rule_version=excluded.rule_version,updated_by=excluded.updated_by,updated_at=datetime('now')`).bind(id,date,expected,actorId).run();
 }else if(prior?.active){
  await db.prepare("UPDATE recurring_block_exceptions SET active=0,rule_version=?,updated_by=?,updated_at=datetime('now') WHERE rule_id=? AND date=? AND active=1").bind(expected,actorId,id,date).run();
 }
 return {rule:await readRule(db,id)};
}

export async function recurringIntervals(db,from,to){
 const state=await assertRecurrenceReady(db);if(!state.ready)return [];
 const rules=await all(db,'SELECT * FROM recurring_blocks WHERE enabled=1 AND deleted_at IS NULL AND start_date<=? AND (end_date IS NULL OR end_date>=?)',to,from);
 if(!rules.length)return [];
 const exceptions=await all(db,'SELECT rule_id,date FROM recurring_block_exceptions WHERE active=1 AND date BETWEEN ? AND ?',from,to),excluded=new Set(exceptions.map(row=>`${row.rule_id}/${row.date}`)),result=[];
 for(let date=from;date<=to;){for(const rule of rules)if(matchesRecurrence(rule,date)&&!excluded.has(`${rule.id}/${date}`))result.push({date,start_min:rule.start_min,end_min:rule.end_min});if(date===to)break;date=addDays(date,1);}
 return result;
}
