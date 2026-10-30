export class ApiError extends Error { constructor(status,code,message){super(message);this.status=status;this.code=code;} }
export const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
export const defaults={shop_name:'jinSling 예약',contact_phone:'',booking_window_days:30,cancel_before_minutes:0,member_limit:100,registration_open:true};
export const publicUser=u=>u?{...Object.fromEntries(['id','username','name','phone','role','status'].map(k=>[k,u[k]??null])),created_at:utc(u.created_at),needs_password_setup:!u.provider_uid,password_reset_required:!!u.password_reset_required}:null;
export const utc=value=>value==null?null:new Date(value.includes('T')?value:value.replace(' ','T')+'Z').toISOString();
export const publicTimestamps=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,key.endsWith('_at')?utc(value):value]));
export const publicBooking=b=>publicTimestamps(Object.fromEntries(['id','user_id','customer_name','phone','date','start_time','end_time','memo','status','version','created_at','updated_at'].map(k=>[k,b[k]])));
export const publicSettings=s=>Object.fromEntries(Object.keys(defaults).map(k=>[k,k==='registration_open'?!!s[k]:s[k]]));
export const publicRule=r=>({weekday:r.weekday,closed:!!r.closed,open_time:r.open_time,close_time:r.close_time,daily_limit:r.daily_limit});
export const publicBlock=b=>Object.fromEntries(['id','date','start_time','end_time','note'].map(k=>[k,b[k]]));
export const token=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
export async function hash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export const uuid=()=>crypto.randomUUID();
export const cookie=value=>`__Host-jinsling_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${value?2592000:0}`;
export const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
export const seoulNow=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,16).replace('T',' ');
export const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function text(value,label,max,{empty=false}={}){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))fail(400,'invalid_input',`${label} 값을 확인해 주세요.`);return value.trim();}
export function phone(value,{empty=false}={}){const p=text(value,'전화번호',30,{empty});if((p||!empty)&&!/^\+?[0-9][0-9 ()-]{6,28}[0-9]$/.test(p))fail(400,'invalid_input','전화번호를 확인해 주세요.');return p;}
export function integer(value,min,max,label='숫자'){if(!Number.isInteger(value)||value<min||value>max)fail(400,'invalid_input',`${label} 값을 확인해 주세요.`);return value;}
export function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail(400,'invalid_input','날짜를 확인해 주세요.');return value;}
export function minute(value,{end=false}={}){if(typeof value!=='string'||!/^\d{2}:(00|30)$/.test(value))fail(400,'invalid_input','30분 단위 시간을 선택해 주세요.');const n=Number(value.slice(0,2))*60+Number(value.slice(3));if(n<0||n>(end?1440:1410)||(n===1440&&value!=='24:00'))fail(400,'invalid_input','시간을 확인해 주세요.');return n;}
export const time=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export const version=b=>integer(b.version,1,2147483647,'버전');
export function only(body,fields){for(const key of Object.keys(body))if(!fields.includes(key))fail(400,'invalid_input','알 수 없는 입력 항목입니다.');}
export async function readJson(request){
 if(request.headers.get('X-JinSling-Request')!=='1')fail(403,'csrf','요청을 확인할 수 없습니다.');
 const origin=request.headers.get('Origin');if(origin!==null&&origin!==new URL(request.url).origin)fail(403,'csrf','요청을 확인할 수 없습니다.');
 const site=request.headers.get('Sec-Fetch-Site');if(site&&!['same-origin','none'].includes(site))fail(403,'csrf','요청을 확인할 수 없습니다.');
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))fail(415,'content_type','JSON 요청이 필요합니다.');
 if(Number(request.headers.get('Content-Length')||0)>16384)fail(413,'too_large','요청이 너무 큽니다.');
 const reader=request.body?.getReader();let size=0;const chunks=[];if(reader){while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();fail(413,'too_large','요청이 너무 큽니다.');}chunks.push(value);}}
 let b;try{const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}b=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'invalid_json','JSON 형식을 확인해 주세요.');}
 if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'invalid_input','객체 형식이 필요합니다.');return b;
}
export const securityHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
export const json=(data,headers={})=>new Response(JSON.stringify({ok:true,data}),{headers:{...securityHeaders,'Content-Type':'application/json; charset=utf-8',...headers}});
export function errorResponse(error){const known=error instanceof ApiError;return new Response(JSON.stringify({ok:false,error:{code:known?error.code:'internal_error',message:known?error.message:'요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.'}}),{status:known?error.status:500,headers:{...securityHeaders,'Content-Type':'application/json; charset=utf-8',...(known&&error.status===429?{'Retry-After':'900'}:{})}});}
export function sqlError(error){if(error instanceof ApiError)throw error;const message=String(error?.message||'');if(/registration_closed/.test(message))fail(403,'registration_closed','신규 회원 가입이 잠시 닫혀 있습니다.');if(/users\.username|users_username/.test(message))fail(409,'username_taken','이미 사용 중인 아이디입니다.');if(/member_limit/.test(message))fail(409,'member_limit','설정된 회원 수 한도에 도달했습니다.');if(/invalid_invite/.test(message))fail(403,'invalid_invite','유효하지 않거나 만료된 초대입니다.');if(/constraint|conflict|limit|closed|outside_window|stale_version|immutable_booking/i.test(message))fail(409,'conflict','이미 변경되었거나 예약 조건과 충돌합니다. 새로고침 후 확인해 주세요.');throw error;}

export function username(value){if(typeof value!=='string')fail(400,'invalid_input','아이디를 확인해 주세요.');const result=value.trim().toLowerCase();if(!/^[a-z0-9_]{4,32}$/.test(result))fail(400,'invalid_input','아이디는 영문, 숫자, 밑줄 4~32자입니다.');return result;}
export function password(value){if(typeof value!=='string'||Array.from(value).length<15||Array.from(value).length>128)fail(400,'invalid_input','비밀번호는 15~128자입니다.');return value;}
export function csvResponse(rows,columns,filename){const cell=value=>{let s=String(value??'');if(/^[\s\uFEFF]*[=+\-@]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const csv='\uFEFF'+[columns.map(cell).join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n')+'\r\n';return new Response(csv,{headers:{...securityHeaders,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`}});}
