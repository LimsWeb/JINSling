import {WEEKDAYS,seoulToday,addDays,dateLabel,consumeAuthFragment,listenForAuthFragments,normalizeUsername,validateNewPassword,canCustomerChange,parseTimestamp,createRequestId} from './ui-utils.mjs';

let {inviteToken,resetToken} = consumeAuthFragment(window.location, window.history);
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const state = {session:null,page:'reserve',date:seoulToday(),slot:null,availability:null,preview:[],calendarMonth:seoulToday().slice(0,7),scheduleMode:'day'};
let renderVersion = 0;
let notificationTimer;
let previewBusy = false;
const statusLabels = {approved:'이용 가능',pending:'승인 대기',suspended:'이용 중지',rejected:'가입 거절',confirmed:'예약 확정',cancelled:'취소됨'};
const actionLabels = {create:'등록',update:'변경',cancel:'예약 취소',approve:'승인',rotate_key:'기존 접속키 재발급',revoke:'철회',join:'가입',bootstrap:'관리자 등록',setup_password:'비밀번호 계정 전환',change_password:'비밀번호 변경',reset_password:'비밀번호 재설정',request_password_reset:'재설정 링크 발급'};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const button = (text, handler, kind = '', props = {}) => el('button',{type:'button',class:`btn ${kind}`,onclick:handler,...props},text);
const badge = status => el('span',{class:`status ${status}`},statusLabels[status] || status);
const empty = text => el('div',{class:'empty'},text);
const loading = () => el('div',{class:'loading',role:'status'},'불러오는 중…');
function notify(message, error = false) {
  const node = document.querySelector('#notification');
  clearTimeout(notificationTimer); node.textContent = message; node.className = `notification${error ? ' error' : ''}`; node.hidden = false;
  notificationTimer = setTimeout(() => {node.hidden = true;},6500);
}
class ApiError extends Error { constructor(message, status, code) {super(message);this.status=status;this.code=code;} }
async function api(path, options = {}) {
  const method = options.method || 'GET';
  let response;
  try {
    response = await fetch(`/api${path}`,{method,credentials:'same-origin',cache:'no-store',headers:method === 'GET' ? {Accept:'application/json'} : {Accept:'application/json','Content-Type':'application/json','X-JinSling-Request':'1'},...(method === 'GET' ? {} : {body:JSON.stringify(options.body || {})})});
  } catch {throw new ApiError('연결하지 못했어요. 인터넷 연결을 확인한 후 다시 시도해 주세요.',0,'NETWORK');}
  let payload;
  try {payload = await response.json();} catch {throw new ApiError('서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.',response.status,'INVALID_RESPONSE');}
  if (!response.ok || !payload.ok) throw new ApiError(payload.error?.message || '요청을 처리하지 못했어요.',response.status,payload.error?.code);
  return payload.data;
}
function inlineError(parent,error) {
  parent.querySelector('.inline-error')?.remove();
  const message = el('div',{class:'inline-error',role:'alert',tabindex:'-1'},error.message);
  parent.prepend(message);message.focus();
}
function field(label,name,type='text',value='',props={}) {
  return el('label',{},label,el(type==='textarea' ? 'textarea':'input',{name,...(type==='textarea'?{}:{type}),...(type==='textarea'?{}:{value}),...props},...(type==='textarea'?[value]:[])));
}
function usernameField(value='',readOnly=false){
  const input=field('아이디','username','text',value,{required:true,autocomplete:'username',autocapitalize:'none',spellcheck:'false',readonly:readOnly});
  if(!readOnly)input.append(el('small',{class:'field-hint'},'영문, 숫자, 밑줄(_) 4–32자 · 대소문자는 구분하지 않아요.'));
  return input;
}
function newPasswordFields(name='password'){
  const password=field('새 비밀번호',name,'password','',{required:true,autocomplete:'new-password'});
  // Native maxlength counts UTF-16 units; validation below counts Unicode
  // characters, matching the API and preserving all password whitespace.
  password.append(el('small',{class:'field-hint'},'15–128자. 한글과 공백도 사용할 수 있고, 앞뒤 공백도 포함돼요.'));
  return [password,field('새 비밀번호 확인','password_confirm','password','',{required:true,autocomplete:'new-password'})];
}
function form(fields,submitText,onSubmit) {
  const submit = el('button',{type:'submit',class:'btn full'},submitText);
  const node = el('form',{class:'form-stack'},fields,submit);
  let busy = false;
  node.addEventListener('submit',async event => {
    event.preventDefault();if(busy)return;
    busy = true;submit.disabled = true;submit.textContent = '처리 중…';node.setAttribute('aria-busy','true');
    node.querySelector('.inline-error')?.remove();
    try {await onSubmit(Object.fromEntries(new FormData(node)),node);} catch(error) {inlineError(node,error);} finally {busy=false;submit.disabled=false;submit.textContent=submitText;node.removeAttribute('aria-busy');}
  });
  return node;
}
function openDialog(title,content,options={}) {
  if(dialog.open)dialog.close();
  const close = button('×',()=>dialog.close(),'dialog-close',{'aria-label':'창 닫기'});
  dialog.replaceChildren(el('div',{class:'dialog-head'},el('h2',{id:'dialog-title'},title),close),content);
  dialog.oncancel = options.preventEscape ? event => event.preventDefault() : null;
  dialog.onclose = () => {if(dialog.open)return;dialog.replaceChildren();options.onClose?.();};
  dialog.showModal();
}
function confirmation(title,text,submitText,action) {
  const content = el('div',{},el('p',{},text));
  const errorArea = el('div');
  const accept = button(submitText,async()=>{
    if(accept.disabled)return;accept.disabled=true;accept.textContent='처리 중…';
    try{await action();dialog.close();}catch(error){inlineError(errorArea,error);accept.disabled=false;accept.textContent=submitText;}
  });
  content.append(errorArea,el('div',{class:'dialog-actions'},button('돌아가기',()=>dialog.close(),'secondary'),accept));
  openDialog(title,content);
}
function secretDialog(title,secret,{invite=false,expiresAt,onClose}={}) {
  const description=invite ? '이 초대 링크는 7일 동안 한 번 사용할 수 있어요. 초대할 분에게 직접 전달해 주세요.' : '이 재설정 링크는 24시간 동안 한 번 사용할 수 있어요. 지금 한 번만 표시되므로 본인에게 안전하게 전달해 주세요. 비밀번호는 본인이 직접 정해요.';
  const content = el('div',{},el('div',{class:'secret-warning'},description),expiresAt?el('p',{class:'note'},`사용 기한 · ${timestamp(expiresAt)} (서울)`):null,el('div',{class:'secret-value',tabindex:'0'},secret));
  const feedback=el('p',{class:'muted',role:'status'});
  const copy=button('복사하기',async()=>{
    try {await navigator.clipboard.writeText(secret);feedback.textContent='복사했어요. 안전한 곳에 보관해 주세요.';}catch{feedback.textContent='자동 복사를 사용할 수 없어요. 위 내용을 선택해서 직접 복사해 주세요.';}
  },'secondary');
  const save=button('파일로 보관',()=>{
    const blob=new Blob([`${title}\n${secret}\n${expiresAt?`사용 기한: ${timestamp(expiresAt)} (서울)\n`:''}\n${invite?'초대할 분에게만 전달해 주세요.':'해당 회원 본인에게만 전달해 주세요. 24시간 동안 한 번 사용할 수 있어요.'}\n`],{type:'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);const link=el('a',{href:url,download:invite?'jinSling-invite.txt':'jinSling-password-reset.txt'});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);feedback.textContent='저장한 파일을 안전하게 보관해 주세요.';
  },'outline');
  content.append(el('div',{class:'actions'},copy,save),feedback,el('div',{class:'dialog-actions'},button('보관했어요',()=>dialog.close())));
  openDialog(title,content,{onClose});
}
function finishAuthentication(result,message){
  state.session={...state.session,configured:true,user:result.user};
  inviteToken=null;resetToken=null;
  state.page=result.user.role==='admin'?'schedule':'reserve';
  render();
  if(message)notify(message);
}
function brand(){return el('div',{class:'brand'},el('span',{class:'brand-mark','aria-hidden':'true'},'j.'),el('div',{},el('strong',{},'jinSling'),el('small',{},'YOUR TIME, WELL SPENT')));}
function pageHead(eyebrow,title,description,action) {return el('header',{class:'page-head'},el('div',{},el('div',{class:'eyebrow'},eyebrow),el('h1',{},title),el('p',{},description)),action);}
function contactNote(){const phone=state.session?.settings?.contact_phone;return phone ? `문의 · ${phone}` : '문의는 매장 관리자에게 연락해 주세요.';}
function errorPage(container,error,retry){container.replaceChildren(el('div',{class:'inline-error',role:'alert'},error.message),el('div',{class:'actions section-space'},button('다시 불러오기',retry,'secondary'),button('로그인 상태 확인',refreshSession,'outline')));}

async function loadSession(){state.session=await api('/session');return state.session;}
async function refreshSession(){try{await loadSession();render();}catch(error){notify(error.message,true);}}
function render(){
  renderVersion++;
  const session=state.session;
  if(resetToken!==null){renderAuth('reset');return;}
  if(!session?.configured){renderAuth('bootstrap');return;}
  if(inviteToken!==null && !session.user){renderAuth('join');return;}
  if(!session.user){renderAuth('login');return;}
  if(session.user.needs_password_setup){renderAuth('setup');return;}
  if(session.user.status!=='approved'){renderPending();return;}
  renderShell();
}
function renderAuth(mode){
  const version=++renderVersion;
  const intro=el('section',{class:'auth-intro'},brand(),el('h1',{},'나를 위한 시간,',el('br'),'가볍게 예약해요.'),el('p',{},'편안한 방문을 위한 30분. 원하는 날짜와 시간을 고르면 예약이 시작돼요.'),el('span',{class:'accent-tag'},'가입 승인 한 번, 이후에는 편하게 로그인'));
  const card=el('section',{class:'auth-card'});
  const loginScreen=()=>{inviteToken=null;resetToken=null;renderAuth('login');};
  if(!state.session?.auth_ready){
    card.append(el('h2',{},'로그인 서비스 준비 중'),el('p',{class:'inline-info'},'로그인 서비스가 아직 연결되지 않았어요. 매장 관리자가 설정을 완료하면 가입과 비밀번호 로그인을 이용할 수 있어요.'),el('p',{class:'auth-footer'},contactNote()),button('설정 상태 다시 확인',refreshSession,'outline full'));
    if(state.session?.user)card.append(button('로그아웃',logout,'link-button'));
  }else if(mode==='bootstrap'){
    card.append(el('h2',{},'첫 관리자 등록'),el('p',{},'처음 한 번만 설정해요. 설정 토큰과 관리자 정보를 입력하고 로그인할 아이디를 만들어 주세요.'),form([
      field('설정 토큰','setup_token','password','',{required:true,autocomplete:'off'}),field('관리자 이름','name','text','',{required:true,maxlength:80,autocomplete:'name'}),field('관리자 개인 연락처 (고객에게 비공개)','phone','tel','',{required:true,maxlength:30,autocomplete:'tel'}),usernameField(),...newPasswordFields()
    ],'관리자 등록하기',async values=>{
      const result=await api('/bootstrap',{method:'POST',body:{setup_token:values.setup_token,name:values.name,phone:values.phone,username:normalizeUsername(values.username),password:validateNewPassword(values.password,values.password_confirm)}});
      finishAuthentication(result,'관리자 계정을 만들었어요. 공개할 매장 연락처는 운영 설정에서 따로 정할 수 있어요.');
    }),el('p',{class:'auth-footer'},'개인 연락처는 고객 안내에 자동으로 표시되지 않아요. 등록 후에는 아이디와 비밀번호로 로그인해요.'));
  }else if(mode==='join'){
    card.append(el('h2',{},'처음 오셨나요?'),el('p',{},'아이디와 비밀번호를 만들어 주세요. 관리자가 가입을 한 번 승인하면, 다음부터는 별도 승인 없이 로그인하고 예약할 수 있어요.'));
    if(state.session.settings.registration_open===false){
      card.append(el('div',{class:'inline-info'},'지금은 신규 가입을 받지 않아요. 기존 회원은 계속 로그인할 수 있어요.'));
    }else{
      const signup=form([field('이름','name','text','',{required:true,maxlength:80,autocomplete:'name'}),field('연락처','phone','tel','',{required:true,maxlength:30,autocomplete:'tel'}),usernameField(),...newPasswordFields()],'가입하고 승인 기다리기',async values=>{
        const body={name:values.name,phone:values.phone,username:normalizeUsername(values.username),password:validateNewPassword(values.password,values.password_confirm)};
        if(inviteToken)body.invite_token=inviteToken;
        const result=await api('/auth/join',{method:'POST',body});finishAuthentication(result,'가입 신청을 보냈어요. 첫 승인 후에는 언제든 직접 로그인할 수 있어요.');
      });
      if(inviteToken!==null){
        const note=el('div',{class:'inline-info'},'초대 링크를 확인하고 있어요. 초대 없이도 가입할 수 있어요.');card.append(note);
        api('/auth/invite-info',{method:'POST',body:{invite_token:inviteToken}}).then(info=>{
          if(version!==renderVersion)return;
          if(info.valid)note.textContent='초대 링크를 확인했어요. 가입 정보는 매장 관리자만 확인할 수 있어요.';
          else{inviteToken=null;note.textContent='사용할 수 없는 초대 링크예요. 아래에서 일반 회원 가입을 진행할 수 있어요.';}
        }).catch(()=>{if(version===renderVersion){inviteToken=null;note.textContent='초대 링크를 확인하지 못했어요. 초대 없이 일반 회원 가입을 진행할 수 있어요.';}});
      }
      card.append(signup,el('p',{class:'note'},'이름과 연락처는 회원 확인과 예약 관리를 위해 매장 관리자가 확인해요. 비밀번호는 관리자에게 표시되지 않아요.'));
    }
    card.append(el('p',{class:'auth-footer'},'이미 계정이 있나요? ',button('로그인',loginScreen,'link-button')));
  }else if(mode==='setup'){
    card.append(el('h2',{},'비밀번호 계정으로 전환'),el('p',{},`${state.session.user.name}님, 기존 계정에 아이디와 비밀번호를 한 번 설정해 주세요. 회원 정보, 승인 상태, 예약은 그대로 유지돼요.`),form([usernameField(),...newPasswordFields()],'아이디와 비밀번호 설정',async values=>{
      const result=await api('/auth/setup-password',{method:'POST',body:{username:normalizeUsername(values.username),password:validateNewPassword(values.password,values.password_confirm)}});
      finishAuthentication(result,'비밀번호 계정으로 전환했어요. 앞으로는 아이디와 비밀번호로 로그인해 주세요.');
    }),el('p',{class:'auth-footer'},'전환을 마치면 이전 접속키는 사용할 수 없어요. ',button('로그아웃',logout,'link-button')));
  }else if(mode==='legacy'){
    card.append(el('h2',{},'기존 접속키로 계정 찾기'),el('p',{},'이전에 받은 접속키를 입력하면 같은 계정에 아이디와 비밀번호를 설정할 수 있어요.'),form([field('기존 접속키','login_key','password','',{required:true,autocomplete:'off',spellcheck:'false'})],'기존 계정 확인',async values=>{
      const result=await api('/auth/login',{method:'POST',body:{login_key:values.login_key}});finishAuthentication(result);
    }),el('p',{class:'auth-footer'},'이미 전환하셨나요? ',button('아이디로 로그인',loginScreen,'link-button'),el('br'),'접속키를 잃어버렸다면 매장 관리자에게 문의해 주세요.'));
  }else if(mode==='reset'){
    const activeResetToken=resetToken;
    card.append(el('h2',{},'비밀번호 다시 설정'),el('p',{},'새 비밀번호를 직접 정해 주세요. 회원 정보와 가입 승인 상태는 그대로 유지돼요.'));
    const check=el('div',{},loading());card.append(check);
    api('/auth/reset-info',{method:'POST',body:{reset_token:activeResetToken}}).then(info=>{
      if(version!==renderVersion)return;
      if(!info.valid){check.replaceChildren(el('div',{class:'inline-error',role:'alert'},'사용할 수 없거나 만료된 재설정 링크예요. 관리자에게 새 링크를 요청해 주세요.'));return;}
      check.replaceChildren(el('p',{class:'note'},`사용 기한 · ${timestamp(info.expires_at)} (서울)`),form(newPasswordFields('new_password'),'새 비밀번호 저장',async values=>{
        if(version!==renderVersion)return;
        const result=await api('/auth/reset-password',{method:'POST',body:{reset_token:activeResetToken,new_password:validateNewPassword(values.new_password,values.password_confirm)}});
        if(resetToken!==activeResetToken){state.session={...state.session,configured:true,user:result.user};render();return;}
        finishAuthentication(result,'비밀번호를 다시 설정했어요. 이 링크는 이제 사용할 수 없어요.');
      }));
    }).catch(error=>{if(version===renderVersion){check.replaceChildren();inlineError(check,error);}});
    card.append(el('p',{class:'auth-footer'},button('로그인 화면으로',loginScreen,'link-button')));
  }else{
    card.append(el('h2',{},'다시 오셨네요'),el('p',{},'아이디와 비밀번호로 나의 예약을 확인하세요. 첫 가입 승인 후에는 매번 승인을 받지 않아도 돼요.'),form([usernameField(),field('비밀번호','password','password','',{required:true,autocomplete:'current-password'})],'로그인',async values=>{
      const result=await api('/auth/login',{method:'POST',body:{username:normalizeUsername(values.username),password:values.password}});finishAuthentication(result);
    }),el('p',{class:'auth-footer'},state.session.settings.registration_open===false?'현재 신규 가입은 잠시 쉬고 있어요.':el('span',{},'처음 방문하셨나요? ',button('회원 가입',()=>renderAuth('join'),'link-button')),el('br'),'비밀번호를 잊었다면 관리자에게 재설정 링크를 요청해 주세요.'),el('div',{class:'auth-secondary'},button('기존 접속키 계정 전환',()=>renderAuth('legacy'),'link-button')));
  }
  app.replaceChildren(el('main',{class:'auth-shell'},intro,card));
}
function renderPending(){
  const user=state.session.user;
  const title=user.status==='pending'?'승인을 기다리고 있어요':'현재 예약을 이용할 수 없어요';
  app.replaceChildren(el('main',{class:'workspace'},brand(),el('section',{class:'card pending-card'},el('span',{class:'brand-mark','aria-hidden':'true'},'j.'),badge(user.status),el('h1',{class:'section-space'},title),el('p',{},`${user.name}님, ${user.status==='pending'?'관리자가 처음 가입한 정보를 확인하고 있어요. 한 번 승인되면 이후에는 직접 로그인해서 예약할 수 있어요.':'자세한 내용은 매장 관리자에게 문의해 주세요.'}`),el('p',{class:'muted'},`아이디 · ${user.username}`),el('p',{class:'muted'},contactNote()),el('div',{class:'actions'},button('승인 상태 확인',refreshSession),button('비밀번호 변경',changePassword,'outline'),button('로그아웃',logout,'outline')))));
}
async function logout(){try{await api('/auth/logout',{method:'POST'});state.session.user=null;inviteToken=null;resetToken=null;renderAuth('login');}catch(error){notify(error.message,true);}}
function changePassword(){
  if(!state.session.auth_ready){notify('로그인 서비스 연결을 확인한 후 비밀번호를 변경해 주세요.',true);return;}
  openDialog('내 비밀번호 변경',form([usernameField(state.session.user.username,true),field('현재 비밀번호','current_password','password','',{required:true,autocomplete:'current-password'}),...newPasswordFields('new_password'),el('p',{class:'note'},'변경하면 다른 기기의 로그인은 종료되고, 이 기기에서 계속 사용할 수 있어요.')],'비밀번호 변경',async values=>{
    const result=await api('/auth/change-password',{method:'POST',body:{current_password:values.current_password,new_password:validateNewPassword(values.new_password,values.password_confirm)}});
    state.session.user=result.user;dialog.close();render();notify('비밀번호를 변경했어요. 다른 기기의 로그인은 종료됐어요.');
  }));
}
function renderShell(){
  const admin=state.session.user.role==='admin';
  const links=admin ? [['schedule','◷','예약 일정'],['reserve','＋','예약하기'],['mine','▤','내 예약'],['settings','☷','운영 설정'],['users','♧','회원 관리'],['audit','↗','기록 · 내보내기']] : [['reserve','＋','예약하기'],['mine','▤','내 예약']];
  if(!links.some(([key])=>key===state.page))state.page=admin?'schedule':'reserve';
  const nav=el('nav',{class:'navigation','aria-label':'주 메뉴'},links.map(([key,icon,label])=>el('button',{type:'button',class:`nav-button${state.page===key?' active':''}`,'aria-current':state.page===key?'page':null,onclick:()=>{state.page=key;if(key==='reserve')state.calendarMonth=state.date.slice(0,7);render();}},el('span',{class:'nav-icon','aria-hidden':'true'},icon),label)));
  const user=state.session.user;
  const sidebar=el('aside',{class:'sidebar'},brand(),nav,el('div',{class:'sidebar-bottom'},el('div',{class:'profile'},el('span',{class:'avatar','aria-hidden':'true'},user.name.slice(0,1)),el('div',{},el('strong',{},`${user.name}님`),el('small',{},admin?'매장 관리자':'jinSling 멤버'))),el('div',{class:'profile-actions'},el('button',{type:'button',class:'logout',onclick:changePassword},'비밀번호 변경'),el('button',{type:'button',class:'logout',onclick:logout},'로그아웃'))));
  const main=el('main',{class:'workspace',id:'main-content'});
  main.append(el('div',{class:'topline'},el('span',{},el('span',{class:'tiny-dot'}),state.session.settings.shop_name || 'jinSling 예약'),el('span',{},`${dateLabel(seoulToday())} · 서울`)));
  const content=el('div',{id:'page-content'});main.append(content,el('footer',{class:'footer-note'},el('span',{},'천천히, 나에게 맞는 시간으로.'),el('span',{},contactNote())));
  app.replaceChildren(el('div',{class:'shell'},sidebar,main));
  const version=renderVersion;
  const page=({reserve:renderReserve,mine:renderMine,schedule:renderSchedule,settings:renderSettings,users:renderUsers,audit:renderAudit})[state.page];
  page(content,version).catch(error=>{if(version===renderVersion)errorPage(content,error,render);});
}

function calendar(){
  const month=state.calendarMonth;
  const [year,monthNum]=month.split('-').map(Number);
  const first=new Date(`${month}-01T12:00:00Z`).getUTCDay();
  const count=new Date(Date.UTC(year,monthNum,0)).getUTCDate();
  const today=seoulToday();const last=addDays(today,Number(state.session.settings.booking_window_days));
  const root=el('div');
  const move=amount=>{const value=new Date(Date.UTC(year,monthNum-1+amount,1));state.calendarMonth=value.toISOString().slice(0,7);render();};
  root.append(el('div',{class:'calendar-head'},button('‹',()=>move(-1),'icon-button',{'aria-label':'이전 달'}),el('strong',{},`${year}년 ${monthNum}월`),button('›',()=>move(1),'icon-button',{'aria-label':'다음 달'})));
  const grid=el('div',{class:'calendar-grid','aria-label':`${year}년 ${monthNum}월 날짜 선택`});
  WEEKDAYS.forEach(day=>grid.append(el('div',{class:'calendar-weekday'},day)));
  for(let i=0;i<first;i++)grid.append(el('span',{'aria-hidden':'true'}));
  for(let day=1;day<=count;day++){
    const date=`${month}-${String(day).padStart(2,'0')}`;
    grid.append(el('button',{type:'button',class:`calendar-day${date===state.date?' selected':''}${date===today?' today':''}`,disabled:date<today||date>last,'aria-label':dateLabel(date,true),'aria-pressed':String(date===state.date),onclick:()=>{state.date=date;state.slot=null;render();}},day));
  }
  root.append(grid,el('div',{class:'calendar-legend'},el('span',{},el('i',{class:'legend-circle'}),'선택한 날짜'),el('span',{},`오늘부터 ${state.session.settings.booking_window_days}일 후까지 예약 가능`)));
  return root;
}
async function renderReserve(container,version){
  container.append(pageHead('MAKE A LITTLE TIME','예약하기','원하는 날짜와 시간을 선택해 주세요. 한 번의 예약은 30분이에요.'));
  const left=el('section',{class:'card'},el('div',{class:'card-head'},el('h2',{},'01 날짜 선택'),el('small',{},'Asia / Seoul')),calendar());
  const slotsSection=el('section',{class:'slots-section'},el('div',{class:'card-head'},el('h2',{},'02 시간 선택'),el('small',{},'예약 가능한 시간')),loading());left.append(slotsSection);
  const summary=el('aside',{class:'stack'});container.append(el('div',{class:'split'},left,summary));
  renderSummary(summary);
  const availability=await api(`/availability?date=${encodeURIComponent(state.date)}`);
  if(version!==renderVersion)return;
  state.availability=availability;
  if(!availability.slots.some(slot=>slot.start_time===state.slot&&slot.available))state.slot=null;
  const grid=el('div',{class:'slot-grid'});
  for(const slot of availability.slots)grid.append(el('button',{type:'button',class:`slot${state.slot===slot.start_time?' selected':''}`,disabled:!slot.available,'aria-pressed':String(state.slot===slot.start_time),'aria-label':`${slot.start_time}부터 ${slot.end_time}까지${slot.available?' 예약 가능':' 예약 불가'}`,onclick:event=>{
    state.slot=slot.start_time;grid.querySelectorAll('button').forEach(node=>{node.classList.remove('selected');node.setAttribute('aria-pressed','false');});event.currentTarget.classList.add('selected');event.currentTarget.setAttribute('aria-pressed','true');renderSummary(summary);
  }},slot.start_time));
  slotsSection.replaceChildren(el('div',{class:'card-head'},el('h2',{},'02 시간 선택'),el('small',{},`${availability.booked_count} / ${availability.daily_limit}건`)),availability.closed||!availability.slots.length ? empty(availability.reason || '이 날은 쉬어 가요. 다른 날짜를 선택해 주세요.') : grid);
  if(availability.reason&&!availability.closed&&availability.slots.length)slotsSection.append(el('p',{class:'note'},availability.reason));
  renderSummary(summary);
}
function renderSummary(container){
  const summary=el('section',{class:'card booking-summary'},el('div',{class:'card-head'},el('h2',{},'나의 예약'),el('span',{class:'accent-tag'},'30분의 여유')),el('div',{class:'summary-label'},'선택한 날짜'),el('div',{class:'summary-date'},dateLabel(state.date)),el('div',{class:'summary-time'},state.slot || '시간을 골라 주세요',state.slot?el('span',{class:'duration'},'30분'):null));
  const memo=field('전달할 메모 (선택)','memo','textarea','',{placeholder:'방문 전에 전할 내용을 남겨 주세요.',maxlength:1000});
  const book=button('예약 내용 확인',()=>{
    const selected={date:state.date,start_time:state.slot,memo:memo.querySelector('textarea').value,request_id:createRequestId()};
    confirmation('이 시간으로 예약할까요?',`${dateLabel(selected.date)} ${selected.start_time} · 30분\n예약이 저장되면 확정 내역을 확인할 수 있어요.`,'예약 확정하기',async()=>{
      const result=await api('/bookings',{method:'POST',body:selected});
      state.page='mine';render();notify(`${result.booking.date} ${result.booking.start_time} 예약이 확정됐어요.`);
    });
  },'full',{disabled:!state.slot});
  const cutoff=Number(state.session.settings.cancel_before_minutes);
  summary.append(memo,el('div',{class:'section-space'},book),el('p',{class:'note'},`예약 취소는 ${cutoff===0?'예약 시작 전까지':`시작 ${cutoff}분 전까지`} 가능해요. 변경이 필요하면 예약을 취소하고 다시 선택하거나 매장에 문의해 주세요.`));
  container.replaceChildren(summary,el('section',{class:'hint-card'},el('h3',{},'방문 전, 확인해 주세요'),el('p',{},'같은 시간에는 한 분만 예약할 수 있어요.',el('br'),'선택한 시간은 예약 확정 시 다시 확인해요.',el('br'),contactNote())));
}

function bookingCard(booking,{admin=false}={}){
  const date=el('div',{class:'booking-date'},el('strong',{},Number(booking.date.slice(8))),el('span',{},`${Number(booking.date.slice(5,7))}월 · ${WEEKDAYS[new Date(`${booking.date}T12:00:00Z`).getUTCDay()]}`));
  const details=el('div',{class:'booking-details'},el('h3',{},`${booking.start_time} – ${booking.end_time}`,badge(booking.status)),el('p',{},admin?`${booking.customer_name} · ${booking.phone || '연락처 없음'}`:state.session.settings.shop_name));
  if(booking.memo)details.append(el('p',{class:'memo'},booking.memo));
  const editable=booking.status==='confirmed'&&(admin||canCustomerChange(booking,state.session.settings.cancel_before_minutes));
  const actions=el('div',{class:'actions'});
  if(editable){actions.append(button(admin?'일정 · 메모 변경':'메모 수정',()=>editBooking(booking,admin),'outline small'),button('예약 취소',()=>cancelBooking(booking),'danger small'));}
  return el('article',{class:'card booking-card'},date,details,actions);
}
async function renderMine(container,version){
  container.append(pageHead('MY RESERVATIONS','내 예약','다가오는 방문부터 지난 예약까지 한눈에 확인하세요.',button('새로고침',render,'outline')));
  const today=seoulToday();
  const range=form([el('div',{class:'field-row'},field('조회 시작일','from','date',addDays(today,-30),{required:true}),field('조회 종료일','to','date',addDays(today,Number(state.session.settings.booking_window_days)),{required:true}))],'기간 조회',async values=>{if(values.from>values.to)throw new Error('종료일을 시작일 이후로 선택해 주세요.');const data=await api(`/bookings?from=${values.from}&to=${values.to}`);renderItems(data.items);});
  const wrap=el('section',{class:'card'},range);const list=el('div',{class:'stack section-space'},loading());container.append(wrap,list);
  const renderItems=items=>{
    const own=items.filter(item=>item.user_id===state.session.user.id).sort((a,b)=>`${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
    list.replaceChildren(...(own.length?own.map(item=>bookingCard(item)): [empty('이 기간에 예약이 없어요. 나에게 맞는 시간을 골라 보세요.')]));
  };
  const data=await api(`/bookings?from=${addDays(today,-30)}&to=${addDays(today,Number(state.session.settings.booking_window_days))}`);if(version===renderVersion)renderItems(data.items);
}
function cancelBooking(booking){
  const content=form([el('p',{},`${dateLabel(booking.date)} ${booking.start_time} 예약을 취소할까요? 취소한 시간은 다시 예약할 수 있어요.`),field('취소 사유 (선택)','reason','textarea','',{maxlength:500})],'예약 취소하기',async values=>{await api(`/bookings/${encodeURIComponent(booking.id)}/cancel`,{method:'POST',body:{version:booking.version,reason:values.reason}});dialog.close();render();notify('예약을 취소했어요.');});
  openDialog('예약 취소',content);
}
function editBooking(booking,admin){
  const fields=[];
  if(admin)fields.push(el('div',{class:'field-row'},field('예약 날짜','date','date',booking.date,{required:true}),field('시작 시간','start_time','time',booking.start_time,{required:true,step:1800})),field('고객 이름','customer_name','text',booking.customer_name,{required:true,maxlength:80}),field('연락처','phone','tel',booking.phone||'',{required:true,maxlength:30}));
  fields.push(field('예약 메모','memo','textarea',booking.memo||'',{maxlength:1000}));
  openDialog(admin?'일정 · 메모 변경':'메모 수정',form(fields,'변경 내용 저장',async values=>{await api(`/bookings/${encodeURIComponent(booking.id)}`,{method:'PATCH',body:{version:booking.version,...values}});dialog.close();render();notify('예약 변경 내용을 저장했어요.');}));
}

async function renderSchedule(container,version){
  const start=state.date,end=state.scheduleMode==='week'?addDays(start,6):start;
  container.append(pageHead('STUDIO SCHEDULE','예약 일정','방문을 준비하고, 전화로 받은 예약도 함께 관리해요.',button('＋ 수기 예약',manualBooking)));
  const dateInput=el('input',{type:'date',value:start,'aria-label':'일정 조회 시작일',onchange:event=>{if(event.target.value){state.date=event.target.value;render();}}});
  const modes=el('div',{class:'segmented'},['day','week'].map(mode=>el('button',{type:'button',class:state.scheduleMode===mode?'active':'','aria-pressed':String(state.scheduleMode===mode),onclick:()=>{state.scheduleMode=mode;render();}},mode==='day'?'하루 보기':'7일 보기')));
  const toolbar=el('div',{class:'toolbar'},modes,button('‹',()=>{state.date=addDays(state.date,state.scheduleMode==='day'?-1:-7);render();},'outline small',{'aria-label':'이전 기간'}),dateInput,button('›',()=>{state.date=addDays(state.date,state.scheduleMode==='day'?1:7);render();},'outline small',{'aria-label':'다음 기간'}),button('오늘',()=>{state.date=seoulToday();render();},'secondary small'),button('새로고침',render,'outline small'));
  container.append(toolbar);const body=el('div',{},loading());container.append(body);
  const data=await api(`/bookings?from=${start}&to=${end}`);if(version!==renderVersion)return;
  const confirmed=data.items.filter(item=>item.status==='confirmed');
  const stats=el('div',{class:'stat-row'},[['확정 예약',confirmed.length],['취소된 예약',data.items.length-confirmed.length],['예약된 시간',`${confirmed.length*.5}시간`]].map(([title,value])=>el('div',{class:'card stat'},el('span',{},title),el('strong',{},value))));
  body.replaceChildren(stats);
  for(let date=start;date<=end;date=addDays(date,1)){
    const items=data.items.filter(item=>item.date===date).sort((a,b)=>a.start_time.localeCompare(b.start_time));
    body.append(el('section',{class:'day-group section-space'},el('h3',{},dateLabel(date)),el('div',{class:'stack'},...(items.length?items.map(item=>bookingCard(item,{admin:true})):[empty('등록된 예약이 없어요.')]))));
  }
  body.append(el('p',{class:'note'},'일정은 자동으로 갱신되지 않아요. 새 예약을 확인하려면 새로고침을 눌러 주세요.'));
}
function manualBooking(){
  const memberSelect=el('select',{name:'user_id'},el('option',{value:''},'전화 · 현장 고객 (계정 연결 없음)'));
  const fields=[el('div',{class:'inline-info'},'전화 · 현장 예약을 등록해요. 기존 회원을 선택하면 해당 고객의 내 예약에도 표시돼요. 연락처만으로 자동 연결하지 않아요.'),el('label',{},'회원 연결 (선택)',memberSelect),field('고객 이름','customer_name','text','',{required:true,maxlength:80}),field('연락처','phone','tel','',{required:true,maxlength:30}),el('div',{class:'field-row'},field('예약 날짜','date','date',state.date,{required:true,min:seoulToday(),max:addDays(seoulToday(),Number(state.session.settings.booking_window_days))}),field('시작 시간','start_time','time','09:00',{required:true,step:1800})),field('메모 (선택)','memo','textarea','',{maxlength:1000})];
  let requestId=createRequestId();
  let previousPayload='';
  const bookingForm=form(fields,'예약 등록하기',async values=>{
    if(!values.user_id)delete values.user_id;
    const payload=JSON.stringify(values);if(previousPayload&&previousPayload!==payload)requestId=createRequestId();previousPayload=payload;
    await api('/bookings',{method:'POST',body:{...values,request_id:requestId}});dialog.close();render();notify('예약을 등록했어요.');
  });
  openDialog('수기 예약 등록',bookingForm);
  api('/admin/users').then(data=>{
    const members=data.items.filter(user=>user.status==='approved');
    for(const user of members)memberSelect.append(el('option',{value:user.id},`${user.name} · ${user.phone}`));
    memberSelect.addEventListener('change',()=>{
      const user=members.find(item=>item.id===memberSelect.value);
      bookingForm.elements.customer_name.value=user?.name||'';
      bookingForm.elements.phone.value=user?.phone||'';
    });
  }).catch(()=>notify('회원 목록을 불러오지 못했어요. 계정 연결 없는 수기 예약은 등록할 수 있어요.',true));
}

async function renderSettings(container,version){
  container.append(pageHead('STUDIO SETTINGS','운영 설정','매장의 리듬에 맞춰 영업시간과 예약 한도를 관리해요.'));
  const content=el('div',{class:'stack'},loading());container.append(content);
  const [data,blocks]=await Promise.all([api('/admin/settings'),api(`/admin/blocks?from=${seoulToday()}&to=${addDays(seoulToday(),365)}`)]);if(version!==renderVersion)return;
  const settings=data.settings;
  const registration=el('label',{class:'checkbox-row'},el('input',{type:'checkbox',name:'registration_open',checked:settings.registration_open}),el('span',{},'새 회원 가입 받기',el('small',{class:'field-hint'},'꺼 두면 신규 가입만 중단돼요. 기존 회원의 로그인과 예약은 계속할 수 있어요.')));
  const basic=el('section',{class:'card'},el('h2',{},'기본 안내'),el('p',{class:'required-note'},'공개 문의 연락처는 고객 화면에 표시돼요. 관리자 개인 연락처와 별도이며, 비워 둘 수 있어요.'),el('div',{class:'field-row'},field('매장 이름','shop_name','text',settings.shop_name,{required:true,maxlength:80}),field('공개 문의 연락처 (선택)','contact_phone','tel',settings.contact_phone||'',{maxlength:30,placeholder:'고객에게 안내할 번호만 입력'})),el('div',{class:'field-row section-space'},field('예약 공개 기간 (일)','booking_window_days','number',settings.booking_window_days,{required:true,min:1,max:90}),field('고객 취소 마감 (시작 전, 분)','cancel_before_minutes','number',settings.cancel_before_minutes,{required:true,min:0,max:10080})),el('div',{class:'section-space'},field('등록 계정 한도 (관리자 포함)','member_limit','number',settings.member_limit??100,{required:true,min:1,max:1000,step:1}),el('p',{class:'note'},'기본 100명, 최대 1,000명까지 설정할 수 있어요. 승인 대기·이용 중지·가입 거절 계정도 포함하며, 하루 예약 한도와는 별개예요.')),el('div',{class:'section-space'},registration));
  const hours=el('section',{class:'card'},el('h2',{},'요일별 영업시간 · 하루 예약 한도'),el('p',{class:'muted'},'한 예약은 30분이에요. 영업시간에 남는 칸이 있어도 하루 한도에 도달하면 예약을 받지 않아요.'));
  const table=el('table',{class:'hours-table'},el('thead',{},el('tr',{},['요일','휴무','시작','종료','하루 한도'].map(title=>el('th',{scope:'col'},title)))));
  const tbody=el('tbody');
  const rules=[...data.weekly_rules].sort((a,b)=>(a.weekday||7)-(b.weekday||7));
  for(const rule of rules){
    const prefix=`rule_${rule.weekday}_`;
    const closed=el('input',{type:'checkbox',name:`${prefix}closed`,checked:Boolean(rule.closed),'aria-label':`${WEEKDAYS[rule.weekday]}요일 휴무`});
    const opening=el('input',{type:'time',name:`${prefix}open_time`,value:rule.open_time||'09:00',step:1800,required:true,'aria-label':`${WEEKDAYS[rule.weekday]}요일 영업 시작`});
    const closing=el('input',{type:'time',name:`${prefix}close_time`,value:rule.close_time||'20:00',step:1800,required:true,'aria-label':`${WEEKDAYS[rule.weekday]}요일 영업 종료`});
    const limit=el('input',{type:'number',name:`${prefix}daily_limit`,value:rule.daily_limit,min:1,max:48,required:true,'aria-label':`${WEEKDAYS[rule.weekday]}요일 하루 예약 한도`});
    const reflect=()=>{for(const node of [opening,closing,limit]){node.disabled=closed.checked;node.required=!closed.checked;}};closed.addEventListener('change',reflect);reflect();
    tbody.append(el('tr',{},el('th',{scope:'row',class:'day-cell'},`${WEEKDAYS[rule.weekday]}요일`),el('td',{},closed),el('td',{},opening),el('td',{},closing),el('td',{},limit)));
  }
  table.append(tbody);hours.append(el('div',{class:'table-scroll'},table),el('p',{class:'note'},'이미 확정된 예약과 충돌하는 휴무·시간·한도 변경은 저장할 수 없어요.'));
  const settingsForm=form([basic,hours],'운영 설정 저장',async values=>{
    const weekly_rules=data.weekly_rules.map(rule=>{const prefix=`rule_${rule.weekday}_`;const closed=values[`${prefix}closed`]==='on';return {weekday:rule.weekday,closed,open_time:values[`${prefix}open_time`]||rule.open_time||'09:00',close_time:values[`${prefix}close_time`]||rule.close_time||'20:00',daily_limit:closed?Number(rule.daily_limit):Number(values[`${prefix}daily_limit`])};});
    const updated={shop_name:values.shop_name,contact_phone:values.contact_phone,booking_window_days:Number(values.booking_window_days),cancel_before_minutes:Number(values.cancel_before_minutes),member_limit:Number(values.member_limit),registration_open:values.registration_open==='on'};
    const result=await api('/admin/settings',{method:'PUT',body:{settings:updated,weekly_rules}});state.session.settings=result.settings;notify('운영 설정을 저장했어요.');render();
  });
  const blockCard=el('section',{class:'card'},el('div',{class:'card-head'},el('h2',{},'휴무 · 시간 차단'),button('＋ 시간 차단',addBlock,'secondary small')),el('p',{class:'muted'},'특정 날짜의 점심시간이나 개인 일정을 비워 둘 수 있어요. 앞으로 1년 이내의 차단을 표시해요.'));
  const blockList=el('div',{class:'stack'});
  if(!blocks.items.length)blockList.append(empty('등록된 시간 차단이 없어요.'));
  for(const block of blocks.items){
    blockList.append(el('div',{class:'inline-info'},el('div',{class:'card-head'},el('strong',{},`${dateLabel(block.date)} · ${block.start_time}–${block.end_time}`),button('해제',()=>confirmation('시간 차단 해제',`${dateLabel(block.date)} ${block.start_time}–${block.end_time} 차단을 해제할까요?`,'해제하기',async()=>{await api(`/admin/blocks/${encodeURIComponent(block.id)}`,{method:'DELETE'});render();notify('시간 차단을 해제했어요.');}),'outline small')),block.note?el('p',{class:'muted'},block.note):null));
  }
  blockCard.append(blockList);content.replaceChildren(settingsForm,blockCard);
}
function addBlock(){
  openDialog('휴무 · 시간 차단',form([field('날짜','date','date',state.date,{required:true,min:seoulToday(),max:addDays(seoulToday(),365)}),el('div',{class:'field-row'},field('시작 시간','start_time','time','12:00',{required:true,step:1800}),field('종료 시간','end_time','time','13:00',{required:true,step:1800})),field('차단 메모','note','textarea','',{maxlength:500,placeholder:'예: 점심시간, 개인 일정'}),el('p',{class:'note'},'오늘부터 365일 후까지 차단을 등록할 수 있어요. 하루 전체를 쉬려면 해당 날짜의 영업 시작부터 종료까지 차단해 주세요.')],'시간 차단 저장',async values=>{await api('/admin/blocks',{method:'POST',body:values});dialog.close();render();notify('시간 차단을 등록했어요.');}));
}

async function renderUsers(container,version){
  container.append(pageHead('OUR MEMBERS','회원 관리','가입을 처음 한 번 승인하면, 회원은 이후 직접 로그인하고 예약할 수 있어요.',el('div',{class:'actions'},el('a',{class:'btn outline',href:'/api/admin/members.csv',download:'jinSling-members.csv'},'회원 CSV 다운로드'),button('＋ 초대 링크',createInvite,'secondary'))));
  const content=el('div',{class:'stack'},loading());container.append(content);
  const [users,invites]=await Promise.all([api('/admin/users'),api('/admin/invites')]);if(version!==renderVersion)return;
  const pending=users.items.filter(user=>user.status==='pending');
  const members=el('section',{class:'card'},el('div',{class:'card-head'},el('h2',{},`등록 회원 ${users.items.length}명`),pending.length?el('span',{class:'accent-tag'},`승인 대기 ${pending.length}명`):null),el('p',{class:'muted'},`현재 등록 한도는 모든 상태의 계정과 관리자 포함 ${state.session.settings.member_limit}명이에요. 신규 가입은 ${state.session.settings.registration_open?'열려':'닫혀'} 있어요. 운영 설정에서 변경할 수 있어요.`),el('p',{class:'note'},'회원 정보와 CSV에는 이름·연락처가 포함돼요. 비밀번호는 표시하거나 내려받을 수 없어요.'));
  const table=el('table',{class:'members-table'},el('thead',{},el('tr',{},['아이디','이름','연락처','상태','가입일','관리'].map(title=>el('th',{scope:'col'},title)))));const tbody=el('tbody');
  for(const user of users.items){
    const actions=el('div',{class:'actions'});
    if(user.status!=='approved')actions.append(button(user.status==='pending'?'승인':'이용 재개',()=>changeUserStatus(user,'approved'),'secondary small'));
    if(user.id!==state.session.user.id&&user.status==='approved')actions.append(button('이용 중지',()=>changeUserStatus(user,'suspended'),'danger small'));
    if(user.status==='pending')actions.append(button('가입 거절',()=>changeUserStatus(user,'rejected'),'danger small'));
    if(user.needs_password_setup)actions.append(el('small',{},'기존 접속키로 로그인 후 비밀번호 설정이 필요해요.'));
    else actions.append(button('비밀번호 재설정',()=>issuePasswordReset(user),'outline small',{disabled:!state.session.auth_ready}));
    tbody.append(el('tr',{},el('td',{class:'member-username'},user.username||'설정 전'),el('td',{},el('strong',{},user.name),el('br'),el('small',{},user.role==='admin'?'관리자':'고객')),el('td',{},user.phone||'—'),el('td',{},badge(user.status),user.password_reset_required?el('small',{class:'reset-required'},'비밀번호 재설정 필요'):null),el('td',{},el('small',{},timestamp(user.created_at))),el('td',{},actions)));
  }
  table.append(tbody);members.append(el('div',{class:'table-scroll'},table));
  const inviteCard=el('section',{class:'card'},el('div',{class:'card-head'},el('h2',{},'초대 링크 기록 (선택)'),el('small',{},'유효기간 7일 · 한 번 사용')),el('p',{class:'muted'},'회원은 초대 링크 없이도 가입할 수 있어요. 초대 링크로 가입해도 첫 승인은 필요해요.'));
  if(!invites.items.length)inviteCard.append(empty('아직 만든 초대 링크가 없어요.'));
  else{
    const list=el('div',{class:'stack'});
    for(const invite of invites.items){
      const expired=parseTimestamp(invite.expires_at).getTime()<Date.now();
      const label=invite.used_at?'가입 완료':invite.revoked_at?'철회됨':expired?'기간 만료':'사용 가능';
      list.append(el('div',{class:'inline-info'},el('div',{class:'card-head'},el('strong',{},label),!invite.used_at&&!invite.revoked_at&&!expired?button('초대 철회',()=>confirmation('초대 링크 철회','아직 사용하지 않은 초대 링크를 철회할까요?','철회하기',async()=>{await api(`/admin/invites/${encodeURIComponent(invite.id)}`,{method:'DELETE'});render();notify('초대를 철회했어요.');}),'outline small'):null),el('small',{},`생성 ${timestamp(invite.created_at)} · 만료 ${timestamp(invite.expires_at)}`)));
    }
    inviteCard.append(list,el('p',{class:'note'},'초대 링크 원문은 생성 직후 한 번만 표시돼요. 보관하지 못했다면 철회하고 새 링크를 만들어 주세요.'));
  }
  content.replaceChildren(members,inviteCard);
}
function changeUserStatus(user,status){
  confirmation(`${user.name}님 ${statusLabels[status]}`,status==='approved'?'이 회원이 예약 서비스를 이용할 수 있도록 승인할까요? 승인 후에는 별도 승인 없이 직접 로그인하고 예약할 수 있어요.':status==='rejected'?'이 회원의 가입을 거절할까요?': '이 회원의 예약 서비스 이용을 중지할까요? 기존 예약은 일정 화면에서 따로 확인해 주세요.',statusLabels[status],async()=>{await api(`/admin/users/${encodeURIComponent(user.id)}`,{method:'PATCH',body:{status}});render();notify('회원 상태를 변경했어요.');});
}
function issuePasswordReset(user){
  const content=el('div',{},el('p',{},`${user.name}님 (${user.username})의 비밀번호 재설정 링크를 만들까요? 발급 즉시 모든 로그인과 이전 재설정 링크가 종료되고, 새 비밀번호를 정할 때까지 일반 로그인이 차단돼요.`),el('p',{class:'note'},'링크는 24시간 동안 한 번 사용할 수 있어요. 회원 정보, 예약, 승인 상태는 그대로 유지돼요.'),user.id===state.session.user.id?el('p',{class:'inline-info'},'내 계정의 재설정 링크를 발급하면 현재 관리자 로그인도 종료돼요. 표시되는 링크를 보관해 주세요.'):null);
  const errorArea=el('div');let busy=false;
  const submit=button('재설정 링크 만들기',async()=>{
    if(busy)return;busy=true;submit.disabled=true;
    try{
      const result=await api(`/admin/users/${encodeURIComponent(user.id)}/reset-password`,{method:'POST'});
      // The one-time plaintext token must be shown before any refresh request.
      secretDialog(`${user.name}님 비밀번호 재설정`,`${window.location.origin}/#reset=${encodeURIComponent(result.reset_token)}`,{expiresAt:result.expires_at,onClose:refreshSession});
    }catch(error){inlineError(errorArea,error);submit.disabled=false;busy=false;}
  });
  content.append(errorArea,el('div',{class:'dialog-actions'},button('돌아가기',()=>dialog.close(),'secondary'),submit));openDialog('비밀번호 재설정 링크 발급',content);
}
let inviteBusy=false;
async function createInvite(){
  if(inviteBusy)return;inviteBusy=true;
  try{const result=await api('/admin/invites',{method:'POST'});secretDialog('새 초대 링크',`${window.location.origin}/#invite=${encodeURIComponent(result.invite_token)}`,{invite:true,onClose:render});}catch(error){notify(error.message,true);}finally{inviteBusy=false;}
}
function timestamp(value){
  if(!value)return '—';
  const date=parseTimestamp(value);return Number.isNaN(date.getTime())?String(value):new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
async function renderAudit(container,version){
  container.append(pageHead('RECORDS & EXPORT','기록 · 내보내기','운영 변경 내역을 확인하고 예약 자료를 보관하세요.',button('새로고침',render,'outline')));
  const today=seoulToday();
  const from=el('input',{type:'date',value:addDays(today,-30),required:true});
  const to=el('input',{type:'date',value:addDays(today,Number(state.session.settings.booking_window_days)),required:true});
  const link=el('a',{class:'btn',download:'jinSling-bookings.csv'},'예약 CSV 다운로드');
  const updateLink=()=>{link.href=`/api/admin/export.csv?from=${from.value}&to=${to.value}`;};from.addEventListener('change',updateLink);to.addEventListener('change',updateLink);updateLink();
  link.addEventListener('click',event=>{if(!from.value||!to.value||from.value>to.value){event.preventDefault();notify('올바른 조회 기간을 선택해 주세요.',true);}});
  container.append(el('section',{class:'card'},el('h2',{},'예약 자료 내보내기'),el('p',{class:'muted'},'선택한 기간의 예약을 CSV 파일로 받아요. 고객 이름과 연락처가 포함되므로 안전하게 보관해 주세요.'),el('div',{class:'export-fields'},el('label',{},'시작일',from),el('label',{},'종료일',to),link)));
  const audit=el('section',{class:'card section-space'},el('div',{class:'card-head'},el('h2',{},'최근 변경 기록'),el('small',{},'최근 100건')),loading());container.append(audit);
  const data=await api('/admin/audit?limit=100');if(version!==renderVersion)return;
  audit.lastChild.remove();
  if(!data.items.length)audit.append(empty('아직 변경 기록이 없어요.'));
  for(const item of data.items){
    const entityLabels={booking:'예약',user:'회원',settings:'운영 설정',block:'시간 차단',invite:'초대',weekly_rule:'영업시간'};
    const details=el('details',{},el('summary',{},'변경 내용 보기'),el('pre',{},JSON.stringify({이전:parseAudit(item.before_data),이후:parseAudit(item.after_data)},null,2)));
    audit.append(el('article',{class:'audit-entry'},el('strong',{},`${entityLabels[item.entity_type]||item.entity_type} · ${actionLabels[item.action]||item.action}`),el('p',{},`${item.actor_name||'시스템'} · ${timestamp(item.created_at)}`),details));
  }
}
function parseAudit(value){if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}}

async function setupPreview(){
  try{
    const response=await fetch('/__preview/identities',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return;
    const result=await response.json();if(!result.ok||!Array.isArray(result.data?.accounts))return;
    state.preview=result.data.accounts.filter(account=>typeof account.username==='string'&&typeof account.password==='string');
    if(!state.preview.length)return;
    const banner=document.querySelector('#preview-banner');banner.hidden=false;banner.className='preview-banner';
    banner.replaceChildren(el('strong',{},'가상 데이터 미리보기 · 실제 예약은 할 수 없어요.'),el('span',{},'시험 계정으로 화면을 둘러보세요.'),...state.preview.map(account=>button(`${account.name} · ${account.role==='admin'?'관리자':'고객'} 체험`,async()=>{
      if(previewBusy)return;previewBusy=true;
      try{const result=await api('/auth/login',{method:'POST',body:{username:account.username,password:account.password}});state.calendarMonth=state.date.slice(0,7);finishAuthentication(result,`${account.name} 계정으로 체험하고 있어요.`);}catch(error){notify(error.message,true);}finally{previewBusy=false;}
    },'small')));
  }catch{/* A preview endpoint is intentionally absent from real deployments. */}
}
async function start(){
  try{await loadSession();state.page=state.session.user?.role==='admin'?'schedule':'reserve';render();setupPreview();}catch(error){app.replaceChildren(el('main',{class:'workspace'},brand(),el('section',{class:'card section-space'},el('h1',{},'잠시 연결을 확인해 주세요'),el('p',{class:'inline-error',role:'alert'},error.message),button('다시 시도',start))));}
}
listenForAuthFragments(window,tokens=>{
  ({inviteToken,resetToken}=tokens);
  // Invalidate earlier reset/invite checks, including during initial loading.
  renderVersion++;
  dialog.onclose=null;
  if(dialog.open)dialog.close();
  dialog.replaceChildren();
  if(state.session)render();
});
start();
