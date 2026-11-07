import {addDays,fail,hash,minute,only,publicBlock,text,time,today,validDate} from './support.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRESETS={day:[0,1440],morning:[0,720],afternoon:[720,1440]};
function requestId(value){if(typeof value!=='string'||!UUID.test(value))fail(400,'invalid_input','요청 번호를 확인해 주세요.');return value.toLowerCase();}
function closureInput(body){
 only(body,['from','to','period','start_time','end_time','note','request_id']);
 const from=validDate(body.from),to=validDate(body.to),count=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000+1;
 if(count<1||count>31)fail(400,'invalid_input','휴무는 한 번에 1~31일을 선택해 주세요.');
 const period=body.period;if(typeof period!=='string'||(!Object.hasOwn(PRESETS,period)&&period!=='custom'))fail(400,'invalid_input','휴무 시간대를 확인해 주세요.');
 const [start,end]=period==='custom'?[minute(body.start_time),minute(body.end_time,{end:true})]:PRESETS[period];
 if(start>=end)fail(400,'invalid_input','차단 시간을 확인해 주세요.');
 const note=text(body.note??'','메모',500,{empty:true}),id=body.request_id===undefined?null:requestId(body.request_id);
 return {from,to,period,start_time:time(start),end_time:time(end),dates:Array.from({length:count},(_,index)=>addDays(from,index)),count,start,end,note,request_id:id};
}
function withinWindow(input){const current=today();if(input.from<current||input.to>addDays(current,365))fail(400,'invalid_input','오늘부터 365일 이내의 휴무만 등록할 수 있습니다.');}
async function conflicts(db,input){return (await db.prepare("SELECT date,start_time,end_time FROM bookings WHERE date BETWEEN ? AND ? AND status='confirmed' AND start_min<? AND end_min>? ORDER BY date,start_min,id").bind(input.from,input.to,input.end,input.start).all()).results;}

export async function previewClosures(db,body){
 const input=closureInput(body);withinWindow(input);
 const {from,to,period,start_time,end_time,dates,count}=input;
 return {from,to,period,start_time,end_time,dates,count,conflicts:await conflicts(db,input)};
}

export async function createClosures(db,body,actorId){
 const input=closureInput(body),batchId=requestId(input.request_id);
 // The fingerprint retains the full normalized request without a schema change.
 // All IDs share a UUID prefix, including soft-deleted rows, so releasing a group
 // does not erase its request identity or allow a later retry to recreate it.
 const fingerprint=await hash(JSON.stringify({actor_id:actorId,from:input.from,to:input.to,period:input.period,start_time:input.start_time,end_time:input.end_time,note:input.note}));
 const prefix=`bulk_${batchId}_`,matching=`${prefix}${fingerprint}_`,ids=input.dates.map(date=>matching+date);
 const readBatch=async()=>(await db.prepare('SELECT * FROM blocks WHERE id GLOB ? ORDER BY date,id').bind(prefix+'*').all()).results;
 const result=rows=>{
  if(rows.length!==ids.length||rows.some((row,index)=>row.id!==ids[index]||row.created_by!==actorId||row.date!==input.dates[index]||row.start_time!==input.start_time||row.end_time!==input.end_time||row.start_min!==input.start||row.end_min!==input.end||row.note!==input.note))fail(409,'idempotency_conflict','같은 요청 번호의 내용이 다릅니다. 새 요청으로 다시 확인해 주세요.');
  return {batch_id:batchId,items:rows.filter(row=>row.deleted_at===null).map(publicBlock)};
 };
 let existing=await readBatch();if(existing.length)return result(existing);
 withinWindow(input);
 if((await conflicts(db,input)).length)fail(409,'conflict','이미 예약된 시간이 포함되어 있습니다. 휴무 미리보기에서 날짜와 시간을 확인해 주세요.');
 const statements=input.dates.map((date,index)=>db.prepare(`INSERT INTO blocks(id,date,start_time,end_time,start_min,end_min,note,created_by)
 SELECT ?,?,?,?,?,?,?,?
 WHERE NOT EXISTS(SELECT 1 FROM blocks WHERE id GLOB ? AND id NOT GLOB ?)
 AND NOT EXISTS(SELECT 1 FROM blocks WHERE id=?)`).bind(ids[index],date,input.start_time,input.end_time,input.start,input.end,input.note,actorId,prefix+'*',matching+'*',ids[index]));
 // D1 batches are transactions: the booking trigger rejects a race on any date
 // and rolls back preceding blocks and their audit records. The in-transaction
 // prefix guard also rejects concurrent UUID reuse, even for disjoint dates.
 try{await db.batch(statements);}catch(error){existing=await readBatch();if(existing.length)return result(existing);throw error;}
 return result(await readBatch());
}

export async function releaseClosures(db,id,actorId){
 const batchId=requestId(id);
 // A single UPDATE is atomic, including every audit trigger. Separate groups
 // and legacy single blocks have different prefixes and remain effective.
 const result=await db.prepare("UPDATE blocks SET deleted_at=datetime('now'),deleted_by=? WHERE id GLOB ? AND deleted_at IS NULL").bind(actorId,`bulk_${batchId}_*`).run();
 return {batch_id:batchId,count:result.meta.changes};
}
