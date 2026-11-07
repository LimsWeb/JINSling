const root=document.querySelector('#app'),dialog=document.querySelector('#confirm-dialog');
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const state={session:null,date:today(),dashboard:null,chat:[],version:0,busy:false};
let statusTimer;
function el(tag,props={},...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props)){
    if(value===false||value==null)continue;
    if(key==='class')node.className=value;
    else if(key.startsWith('on'))node.addEventListener(key.slice(2).toLowerCase(),value);
    else if(['disabled','hidden','checked'].includes(key))node[key]=Boolean(value);
    else node.setAttribute(key,value===true?'':value);
  }
  for(const child of children.flat())if(child!=null)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const button=(text,click,kind='',props={})=>el('button',{type:'button',class:kind,onclick:click,...props},text);
const field=(label,name,type='text',value='',props={})=>el('label',{},label,el('input',{type,name,value,...props}));
function announce(text){const node=document.querySelector('#status');node.textContent=text;node.hidden=false;clearTimeout(statusTimer);statusTimer=setTimeout(()=>node.hidden=true,6000);}
async function api(path,body){
  let response;
  try{response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{Accept:'application/json'}:{'Content-Type':'application/json','X-JinSling-Lab':'1'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});}
  catch{throw new Error('연결하지 못했어요. 잠시 후 다시 확인해 주세요.');}
  let payload;try{payload=await response.json();}catch{throw new Error('응답을 읽지 못했어요. 설정과 연결을 확인해 주세요.');}
  if(!response.ok||!payload.ok){const error=new Error(payload.error?.message||'요청을 처리하지 못했어요.');error.status=response.status;error.code=payload.error?.code;throw error;}
  return payload.data;
}
function modeNote(){
  const live=state.session?.ai_mode==='workers';
  const ready=state.session?.live_ready;
  return el('div',{class:'mode-note'},el('strong',{},live?(ready?'실제 AI 연결 모드':'실제 AI 설정 확인 필요'):'모의 대화 모드'),el('span',{},live?(ready?'무료 한도 안에서 요청을 해석해요. 변경은 확인 후에만 실행돼요.':'개발자가 AI 연결과 무료 요금제 설정을 확인해야 해요. 일반 예약 화면은 이용할 수 있어요.'):'정해진 표현으로 기능을 시험해요. 실제 AI의 이해 성능을 보여주는 모드는 아니에요.'));
}
async function start(){
  const version=++state.version;
  state.busy=false;
  try{const session=await api('/session');if(version!==state.version)return;state.session=session;render();if(state.session.user?.status==='approved')await refreshDashboard();}
  catch(error){if(version!==state.version)return;root.replaceChildren(el('section',{class:'setup-card'},el('span',{class:'eyebrow'},'AI LAB'),el('h1',{},'실험실 연결을 확인해 주세요.'),el('p',{},error.message),button('다시 확인',start)));}
}
function render(){
  dialog.close();dialog.replaceChildren();
  if(!state.session.user){renderLogin();return;}
  const user=state.session.user,owner=user.role==='owner';
  const header=el('div',{class:'workspace-head'},el('div',{},el('p',{class:'eyebrow'},owner?'OWNER WORKSPACE':'MEMBER WORKSPACE'),el('h1',{},owner?'말로 정리하는 매장 일정':'편한 말로, 다음 예약'),el('p',{class:'muted'},`${user.name} · ${owner?'사장님':'회원'} 체험`)),button('로그아웃',logout,'outline'));
  if(user.status!=='approved'){
    root.replaceChildren(header,el('section',{class:'panel'},el('h2',{},'승인을 기다리고 있어요.'),el('p',{},'사장님 체험 계정으로 회원을 승인하면 예약을 시험할 수 있어요.'),button('승인 상태 확인',start)));return;
  }
  root.replaceChildren(header,modeNote(),el('div',{class:'workspace'},el('section',{class:'panel operations'},el('div',{class:'panel-heading'},el('h2',{},owner?'일정과 회원':'예약 화면'),button('새로고침',()=>refreshDashboard().catch(e=>announce(e.message)),'text-button')),el('div',{class:'date-controls'},field('확인할 날짜','date','date',state.date,{min:today(),max:addDays(today(),30),onchange:async e=>{state.date=e.target.value;await refreshDashboard().catch(error=>announce(error.message));}})),el('div',{id:'dashboard'},'일정을 불러오고 있어요.')),chatPanel(owner)),el('details',{class:'lab-help'},el('summary',{},'실험실 이용 방법'),el('ol',{},el('li',{},'대화창에서 원하는 날짜와 시간을 말하거나 예약 화면에서 시간을 골라요.'),el('li',{},'변경할 내용을 확인한 뒤 실행해요. 확인 전에는 예약이나 회원 상태가 바뀌지 않아요.'),el('li',{},'실험 중에는 가상 이름과 가상 예약만 사용해 주세요. 운영 중인 매장에는 반영되지 않아요.'),el('li',{},'AI가 멈추거나 이해하지 못하면 일반 예약 화면으로 같은 기능을 시험할 수 있어요.'))));
  drawChat();
}
function renderLogin(){
  const select=el('select',{name:'account'},...['owner','member_a','member_b','pending'].map((id,i)=>el('option',{value:id},['가상 사장님','가상 회원 A','가상 회원 B','승인 대기 회원'][i])));
  const error=el('p',{class:'error',role:'alert'});
  const submit=el('button',{type:'submit'},'실험실 들어가기');
  const form=el('form',{class:'stack',onsubmit:async event=>{
    event.preventDefault();submit.disabled=true;error.textContent='';
    const values=Object.fromEntries(new FormData(form));
    try{await login(values);}catch(e){error.textContent=e.message;}finally{submit.disabled=false;}
  }},el('label',{},'체험할 계정',select),field('입장 코드','access_code','password','',{required:true,autocomplete:'off'}),error,submit);
  root.replaceChildren(el('div',{class:'login-grid'},el('section',{class:'intro'},el('p',{class:'eyebrow'},'RESERVATIONS, IN CONVERSATION'),el('h1',{},'예약을 말로,',el('br'),'관리는 한눈에.'),el('p',{},'사장님의 일정 관리와 손님의 예약을 대화로 연결해 보는 실험이에요.'),el('div',{class:'intro-note'},'가상 데이터만 사용하는 별도 프로젝트')),el('section',{class:'panel login-panel'},el('h2',{},'누구의 화면을 볼까요?'),el('p',{class:'muted'},'개발자가 전달한 실험용 입장 코드를 입력해 주세요.'),form,el('div',{id:'local-demo'}))));
  if(['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
    fetch('/__lab/demo',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{
      const target=document.querySelector('#local-demo');if(!data||!target)return;
      target.append(el('p',{class:'muted'},'개발 미리보기 · 가상 계정 바로 열기'),el('div',{class:'demo-buttons'},...['owner','member_a','member_b','pending'].map((account,i)=>button(['사장님 체험','회원 A 체험','회원 B 체험','승인 대기 체험'][i],()=>login({account,access_code:account==='owner'?data.owner_code:data.member_code}).catch(e=>announce(e.message)),'outline'))));
    }).catch(()=>{});
  }
}
async function login(values){await api('/login',values);state.chat=[];state.dashboard=null;await start();}
async function logout(){try{await api('/logout',{});state.chat=[];state.dashboard=null;await start();}catch(e){announce(e.message);}}
async function refreshDashboard(){
  const version=state.version,date=state.date;
  const session=await api('/session');
  if(version!==state.version)return;
  const old=state.session.user,now=session.user;
  if(old?.id!==now?.id||old?.status!==now?.status){state.chat=[];state.busy=false;state.dashboard=null;state.session=session;state.version++;render();if(now?.status==='approved')await refreshDashboard();return;}
  state.session=session;
  const data=await api('/dashboard?date='+encodeURIComponent(date));
  if(version!==state.version||date!==state.date)return;
  state.dashboard=data;drawDashboard();
}
function drawDashboard(){
  const target=document.querySelector('#dashboard');if(!target)return;
  const data=state.dashboard,owner=state.session.user.role==='owner';
  if(!data)return;
  const memberSelect=owner?el('label',{},'예약할 회원',el('select',{id:'booking-member'},...(data.members||[]).filter(x=>x.id!=='owner'&&x.status==='approved').map(x=>el('option',{value:x.id},x.name)))):null;
  const slots=el('div',{class:'slot-grid'},...(data.slots||[]).map(slot=>button(slot.start_time,()=>propose('book',{date:state.date,start_time:slot.start_time,...(owner?{member_id:document.querySelector('#booking-member')?.value}:{})}),'slot',{disabled:!slot.available,'aria-label':`${slot.start_time} ${slot.available?'예약 가능':({booked:'예약됨',blocked:'잠김',past:'지난 시간',capacity:'마감'})[slot.status]||'예약 불가'}`})));
  const upcoming=el('section',{class:'section-gap'},el('h3',{},owner?'선택한 날의 예약':'선택한 날의 내 예약'));
  const bookings=data.bookings||[];
  if(!bookings.length)upcoming.append(el('p',{class:'muted'},'표시할 예약이 없어요.'));
  for(const booking of bookings){
    const row=el('div',{class:'list-row'},el('div',{},el('strong',{},`${booking.date} ${booking.start_time}–${booking.end_time}`),el('small',{},owner?booking.member_name:'나의 예약'),el('small',{},booking.status==='cancelled'?'취소됨':'예약됨')));
    if(booking.status!=='cancelled')row.append(button('취소',()=>propose('cancel',{booking_id:booking.id}),'outline small'));
    upcoming.append(row);
  }
  target.replaceChildren(...[memberSelect,el('p',{class:'muted'},'한 번에 30분이에요. 시간을 고르면 예약 내용을 먼저 보여 드려요.'),slots,(data.slots||[]).length?null:el('p',{class:'muted'},'이 날짜는 쉬는 날이에요.'),upcoming].filter(Boolean));
  if(owner){
    const period=el('select',{id:'block-period'},el('option',{value:'day'},'하루 전체'),el('option',{value:'morning'},'오전 · 낮 12시까지'),el('option',{value:'afternoon'},'오후 · 낮 12시부터'));
    const blocks=el('section',{class:'section-gap'},el('h3',{},'일정 잠금'),el('div',{class:'inline-controls'},el('label',{},'잠글 시간',period),button('잠금 내용 확인',()=>propose('block',{date:state.date,period:period.value}),'outline')));
    for(const block of data.blocks||[])blocks.append(el('div',{class:'list-row'},el('div',{},el('strong',{},`${block.date} ${block.start_time}–${block.end_time}`),el('small',{},'예약을 받지 않는 시간')),button('해제',()=>propose('unblock',{block_id:block.id}),'outline small')));
    const members=el('section',{class:'section-gap'},el('h3',{},'가상 회원 관리'));
    for(const member of data.members||[]){
      const row=el('div',{class:'list-row'},el('div',{},el('strong',{},member.name),el('small',{},({approved:'이용 가능',pending:'승인 대기',suspended:'이용 중지'})[member.status]||member.status)));
      if(member.id!=='owner')row.append(button(member.status==='approved'?'이용 중지':'승인',()=>propose('member_status',{member_id:member.id,status:member.status==='approved'?'suspended':'approved'}),'outline small'));
      members.append(row);
    }
    target.append(blocks,members);
  }
}
function chatPanel(owner){
  const log=el('div',{id:'chat-log',class:'chat-log',role:'log','aria-live':'polite','aria-label':'예약 대화'});
  const input=el('textarea',{id:'chat-input',name:'message',rows:3,maxlength:512,required:true,placeholder:'예: 내일 오전 10시 예약','aria-label':'대화 내용'});
  const submit=el('button',{type:'submit'},'보내기');
  const form=el('form',{class:'chat-form',onsubmit:async event=>{event.preventDefault();if(state.busy)return;const value=input.value.trim();if(!value)return;input.value='';await sendChat(value);}},input,el('div',{class:'chat-form-footer'},el('small',{},'예약·회원 변경은 확인 후 실행해요.'),submit));
  const examples=owner?['오늘 일정 보여줘','회원 목록 보여줘','내일 오전 잠가줘']:['내일 예약 가능한 시간','내 예약 보여줘','내일 오전 10시 예약'];
  return el('section',{class:'panel conversation'},el('div',{class:'panel-heading'},el('div',{},el('p',{class:'eyebrow'},'JINSLING ASSISTANT'),el('h2',{},'대화로 해볼까요?')),el('span',{class:'status-dot'},'실험 중')),el('div',{class:'examples'},...examples.map(text=>button(text,()=>sendChat(text),'example'))),log,form);
}
function drawChat(){
  const log=document.querySelector('#chat-log');if(!log)return;
  const entries=state.chat.length?state.chat:[{role:'assistant',text:'원하는 날짜와 시간을 알려 주세요. 실행하기 전에는 꼭 내용을 확인해요.'}];
  log.replaceChildren(...entries.map(entry=>{
    const node=el('div',{class:'message '+entry.role},el('small',{},entry.role==='user'?'나':'jinSling'),el('p',{},entry.text));
    if(entry.view){
      const view=entry.view,items=view.items||view.slots||[];
      if(view.date)node.append(el('p',{class:'result-date'},view.date));
      if(!items.length)node.append(el('p',{class:'muted'},'표시할 내용이 없어요.'));
      else node.append(el('ul',{class:'chat-results'},...items.slice(0,48).map(item=>el('li',{},describe(item)))));
    }
    if(entry.proposal)node.append(button('내용 확인하고 실행',()=>showProposal(entry.proposal),'proposal-button'));
    return node;
  }));
  log.scrollTop=log.scrollHeight;
  const busy=state.busy;document.querySelector('#chat-input').disabled=busy;
  document.querySelector('.chat-form button').disabled=busy;
  document.querySelector('.chat-form button').textContent=busy?'확인 중…':'보내기';
  document.querySelectorAll('.example').forEach(b=>b.disabled=busy);
}
function describe(item){
  if(typeof item==='string')return item;
  if(item.start_time)return [item.date,item.start_time+(item.end_time?'–'+item.end_time:''),item.member_name,item.available===true?'예약 가능':({booked:'예약됨',blocked:'잠김',past:'지난 시간',capacity:'마감',cancelled:'취소됨',available:'예약 가능'})[item.status]].filter(Boolean).join(' · ');
  return [item.name,({approved:'이용 가능',pending:'승인 대기',suspended:'이용 중지'})[item.status]].filter(Boolean).join(' · ')||'확인할 항목';
}
async function sendChat(message){
  if(state.busy||!state.session.user)return;
  const version=state.version;state.busy=true;state.chat.push({role:'user',text:message});drawChat();
  try{
    const result=await api('/chat',{message});if(version!==state.version)return;
    state.chat.push({role:'assistant',text:result.message,view:result.view,proposal:result.proposal});
  }catch(error){if(version===state.version)state.chat.push({role:'assistant',text:error.message+' 일반 예약 화면도 이용할 수 있어요.'});}
  finally{if(version===state.version){state.busy=false;drawChat();document.querySelector('#chat-input')?.focus();}}
}
async function propose(action,data){
  const version=state.version;
  try{const result=await api('/propose',{action,data});if(version!==state.version)return;showProposal(result.proposal||result);}
  catch(error){if(version!==state.version)return;announce(error.message);if(error.status===401||error.status===403)await start();}
}
function showProposal(proposal){
  const version=state.version;
  const message=el('p',{class:'error',role:'alert'});
  const submit=button('확인하고 실행',async()=>{
    if(submit.disabled)return;submit.disabled=true;message.textContent='';
    try{
      const result=await api('/confirm',{proposal_id:proposal.id});
      if(version!==state.version||!dialog.contains(submit))return;
      dialog.close();state.chat.push({role:'assistant',text:result.message||'확인한 내용을 반영했어요.'});drawChat();announce(result.message||'반영했어요.');await refreshDashboard();
    }catch(error){if(version!==state.version||!dialog.contains(submit))return;message.textContent=error.message;submit.disabled=false;}
  });
  if(dialog.open)dialog.close();
  dialog.replaceChildren(el('h2',{id:'confirm-title'},'이 내용으로 진행할까요?'),el('p',{class:'proposal-summary'},proposal.summary||'선택한 변경을 확인해 주세요.'),el('p',{class:'muted'},'이 버튼을 눌러야 가상 예약이나 회원 상태가 바뀌어요.'),proposal.expires_at?el('small',{},'확인 가능 시간 · '+new Date(proposal.expires_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})):null,message,el('div',{class:'dialog-actions'},button('돌아가기',()=>dialog.close(),'outline'),submit));
  dialog.showModal();
}
window.addEventListener('focus',()=>{if(state.session?.user&&!dialog.open)refreshDashboard().catch(()=>{});});
void start();
