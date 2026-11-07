import {WEEKDAYS,addDays,createRequestId,dateLabel,seoulToday} from './ui-utils.mjs';

const API_PATH='/admin/recurring-blocks';
const WEEK_ORDER=[1,2,3,4,5,6,0];
const ORDINALS={1:'첫째',2:'둘째',3:'셋째',4:'넷째',5:'다섯째',[-1]:'마지막'};

function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function minutes(value,end=false){
  if(end&&value==='24:00')return 1440;
  if(typeof value!=='string'||!/^([01]\d|2[0-3]):(00|30)$/.test(value))return NaN;
  const [hour,minute]=value.split(':').map(Number);return hour*60+minute;
}
function integer(value,min,max,label){
  const number=Number(value);
  if(value===''||value===null||!Number.isInteger(number)||number<min||number>max)throw new Error(`${label}을 올바르게 선택해 주세요.`);
  return number;
}
export function normalizeRecurringRequest(values,{today=seoulToday(),original=null}={}){
  const frequency=values.frequency;
  if(!['daily','weekly','biweekly','monthly'].includes(frequency))throw new Error('반복 방식을 선택해 주세요.');
  const start_date=values.start_date,end_date=values.end_date||null;
  if(!validDate(start_date)||(end_date!==null&&!validDate(end_date)))throw new Error('시작일과 종료일을 올바르게 선택해 주세요.');
  if((start_date<today&&start_date!==original?.start_date)||start_date>addDays(today,365))throw new Error('시작일은 오늘부터 365일 후까지 선택해 주세요. 기존 시작일은 그대로 유지할 수 있어요.');
  if(end_date&&end_date<start_date)throw new Error('종료일을 시작일과 같거나 이후로 선택해 주세요.');
  const start=minutes(values.start_time),end=minutes(values.end_time,true);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new Error('시작보다 늦은 종료 시간을 30분 단위로 선택해 주세요.');
  const note=String(values.note||'').trim();
  if(Array.from(note).length>500)throw new Error('잠금 메모는 500자 이내로 입력해 주세요.');
  const request={frequency,start_date,end_date,start_time:values.start_time,end_time:values.end_time,note,enabled:values.enabled??original?.enabled??true};
  if(frequency==='weekly'||frequency==='biweekly'){
    const selected=Array.isArray(values.weekdays)?values.weekdays:[];
    if(!selected.length)throw new Error('반복할 요일을 한 개 이상 선택해 주세요.');
    request.weekdays=[...new Set(selected.map(day=>integer(day,0,6,'요일')))].sort((a,b)=>a-b);
  }
  if(frequency==='monthly'){
    if(!['day','weekday'].includes(values.monthly_mode))throw new Error('매달 반복 기준을 선택해 주세요.');
    request.monthly_mode=values.monthly_mode;
    if(values.monthly_mode==='day')request.month_day=integer(values.month_day,1,31,'날짜');
    else{
      const week=Number(values.month_week);
      if(![1,2,3,4,5,-1].includes(week))throw new Error('몇 번째 요일인지 선택해 주세요.');
      request.month_week=week;request.month_weekday=integer(values.month_weekday,0,6,'요일');
    }
  }
  return request;
}
export function recurrenceSummary(rule){
  if(rule.frequency==='daily')return '매일';
  if(rule.frequency==='monthly')return rule.monthly_mode==='weekday'?`매달 ${ORDINALS[rule.month_week]} ${WEEKDAYS[rule.month_weekday]}요일`:`매달 ${rule.month_day}일`;
  const days=WEEK_ORDER.filter(day=>rule.weekdays?.includes(day));
  const labels=days.length===7?'월–일':days.join(',')==='1,2,3,4,5,6'?'월–토':days.join(',')==='1,2,3,4,5'?'월–금':days.map(day=>WEEKDAYS[day]).join('·');
  return `${rule.frequency==='biweekly'?'격주':'매주'} ${labels}`;
}
function periodLabel(rule){return `${dateLabel(rule.start_date,true)}부터 · ${rule.end_date?`${dateLabel(rule.end_date,true)}까지`:'종료일 없음'}`;}
function mondayOf(date){const day=new Date(`${date}T12:00:00Z`).getUTCDay();return addDays(date,-((day+6)%7));}
function selectField(el,label,name,options,value){
  const select=el('select',{name,required:true},options.map(([id,text])=>el('option',{value:id},text)));
  select.value=String(value);return el('label',{},label,select);
}
function timeField(el,label,name,value,end=false){
  const options=[];
  for(let time=0;time<=(end?1440:1410);time+=30){const text=`${String(Math.floor(time/60)).padStart(2,'0')}:${String(time%60).padStart(2,'0')}`;options.push([text,text==='24:00'?'24:00 · 하루 끝':text]);}
  return selectField(el,label,name,options,value);
}

export function showRecurringDialog({api,el,field,button,dialog,openDialog,isContextCurrent,onSaved,onReload,rule=null,preset=null}){
  const today=seoulToday();
  const initial=rule||{frequency:preset==='lunch'?'weekly':'daily',weekdays:[1,2,3,4,5,6],start_date:today,end_date:null,start_time:preset==='lunch'?'13:00':'09:00',end_time:preset==='lunch'?'14:00':'10:00',monthly_mode:'day',month_day:Number(today.slice(8)),month_week:1,month_weekday:1,note:preset==='lunch'?'점심시간':'',enabled:true};
  const frequency=selectField(el,'반복 방식','frequency',[['daily','매일'],['weekly','매주'],['biweekly','격주 · 2주마다'],['monthly','매달']],initial.frequency);
  const weekdays=el('fieldset',{class:'recurring-weekdays'},el('legend',{},'반복할 요일'));
  for(const weekday of WEEK_ORDER)weekdays.append(el('label',{class:'recurring-weekday'},el('input',{type:'checkbox',name:'weekdays',value:weekday,checked:(initial.weekdays||[1,2,3,4,5,6]).includes(weekday),'aria-label':`${WEEKDAYS[weekday]}요일`}),el('span',{},WEEKDAYS[weekday])));
  const monthlyMode=selectField(el,'매달 반복 기준','monthly_mode',[['day','날짜 기준'],['weekday','요일 기준']],initial.monthly_mode||'day');
  const monthlyDay=selectField(el,'반복할 날짜','month_day',Array.from({length:31},(_,index)=>[index+1,`${index+1}일`]),initial.month_day||Number(today.slice(8)));
  const monthlyWeek=el('div',{class:'field-row recurring-row'},selectField(el,'몇 번째','month_week',[1,2,3,4,5,-1].map(value=>[value,ORDINALS[value]]),initial.month_week||1),selectField(el,'반복할 요일','month_weekday',WEEK_ORDER.map(value=>[value,`${WEEKDAYS[value]}요일`]),initial.month_weekday??1));
  const monthly=el('div',{class:'recurring-monthly'},monthlyMode,monthlyDay,monthlyWeek);
  const start=field('시작일','start_date','date',initial.start_date,{required:true,min:initial.start_date<today?initial.start_date:today,max:addDays(today,365)});
  const end=field('종료일','end_date','date',initial.end_date||'',{required:true,min:initial.start_date});
  const endToggle=el('input',{type:'checkbox',name:'has_end_date',checked:Boolean(initial.end_date)});
  const endChoice=el('label',{class:'checkbox-row recurring-end-choice'},endToggle,el('span',{},'종료일 정하기',el('small',{class:'field-hint'},'선택하지 않으면 계속 반복돼요.')));
  const frequencyHint=el('p',{class:'note recurring-frequency-hint'});
  const fields=el('fieldset',{class:'closure-fields recurring-fields'},el('legend',{class:'visually-hidden'},'반복 잠금 내용'),frequency,weekdays,monthly,el('div',{class:'recurring-date-fields'},start,endChoice,end),frequencyHint,el('div',{class:'field-row recurring-row'},timeField(el,'시작 시간','start_time',initial.start_time),timeField(el,'종료 시간','end_time',initial.end_time,true)),el('p',{class:'note recurring-time-hint'},'30분 단위로 선택해요. 하루 전체는 00:00–24:00, 자정을 넘는 시간은 두 개로 나눠 설정해 주세요.'),field('잠금 메모 (선택)','note','textarea',initial.note||'',{maxlength:500,placeholder:'예: 점심시간, 정기 휴무, 정기 일정'}));
  const errorArea=el('div');
  const previewArea=el('section',{class:'closure-preview recurring-preview',hidden:true,'aria-live':'polite','aria-atomic':'true'});
  const previewButton=el('button',{type:'submit',class:'btn secondary full recurring-preview-button'},'반복 일정 미리보기');
  const saveButton=button('확인한 반복 잠금 저장',save,'full recurring-save-button',{disabled:true});
  const confirmationArea=el('div',{class:'closure-confirmation recurring-confirmation',hidden:true},saveButton);
  const status=el('p',{class:'note closure-status recurring-status',role:'status'});
  const content=el('form',{class:'form-stack recurring-form'},el('p',{class:'inline-info'},'반복할 날과 시간을 한 번 정해 두세요. 기존 예약과 겹치면 저장되지 않아요.'),rule&&!rule.enabled?el('p',{class:'note'},'일시중지한 규칙이에요. 수정해도 중지 상태는 유지되며 목록에서 재개할 수 있어요.'):null,fields,errorArea,previewButton,status,previewArea,confirmationArea,el('div',{class:'dialog-actions'},button('닫기',()=>dialog.close(),'outline')));
  let revision=0,preview=null,previewFingerprint='',previewRevision=-1,pendingPreview=false,saving=false,stale=false;
  const requestIds=new Map();
  const current=()=>dialog.open&&dialog.contains(content)&&isContextCurrent();
  const values=()=>{
    const data=new FormData(content);
    return normalizeRecurringRequest({...Object.fromEntries(data),weekdays:data.getAll('weekdays'),enabled:initial.enabled},{original:rule});
  };
  const reflectFields=()=>{
    const value=content.elements.frequency.value;
    weekdays.hidden=!['weekly','biweekly'].includes(value);
    for(const input of weekdays.querySelectorAll('input'))input.disabled=weekdays.hidden;
    monthly.hidden=value!=='monthly';
    monthlyDay.hidden=content.elements.monthly_mode.value!=='day';
    monthlyWeek.hidden=!monthlyDay.hidden;
    for(const select of monthly.querySelectorAll('select'))select.disabled=monthly.hidden||(monthlyDay.contains(select)&&monthlyDay.hidden)||(monthlyWeek.contains(select)&&monthlyWeek.hidden);
    end.hidden=!endToggle.checked;end.querySelector('input').disabled=!endToggle.checked;end.querySelector('input').min=content.elements.start_date.value;
    const selectedDate=content.elements.start_date.value;
    frequencyHint.textContent=value==='biweekly'&&validDate(selectedDate)?`시작일이 속한 주 (${dateLabel(mondayOf(selectedDate))} 시작)부터 한 주 걸러 반복해요. 시작일 전에는 잠기지 않아요.`:value==='monthly'?'29~31일이나 다섯째 요일이 없는 달은 건너뛰어요. 시작일과 종료일을 포함해 적용해요.':'시작일과 종료일을 포함해 적용해요. 잠금 메모는 회원에게 보이지 않아요.';
  };
  const showError=error=>{
    errorArea.replaceChildren(el('div',{class:'inline-error',role:'alert',tabindex:'-1'},error.message));
    if(error.code==='stale_version'){
      stale=true;previewButton.disabled=true;saveButton.disabled=true;
      if(onReload)errorArea.append(button('목록 다시 불러오기',onReload,'outline small'));
    }
    errorArea.firstElementChild.focus();
  };
  const invalidate=()=>{
    revision++;const hadPreview=Boolean(preview)||pendingPreview;
    preview=null;previewFingerprint='';previewRevision=-1;previewArea.hidden=true;previewArea.replaceChildren();confirmationArea.hidden=true;saveButton.disabled=true;
    if(hadPreview)status.textContent='내용이 바뀌었어요. 반복 일정을 다시 미리보기 해 주세요.';
  };
  fields.addEventListener('input',()=>{if(!saving){invalidate();reflectFields();}});
  fields.addEventListener('change',()=>{if(!saving){invalidate();reflectFields();}});
  reflectFields();
  content.addEventListener('submit',async event=>{
    event.preventDefault();if(!current()||pendingPreview||saving||stale)return;
    let request;
    try{request=values();}catch(error){invalidate();showError(error);return;}
    errorArea.replaceChildren();previewArea.hidden=true;confirmationArea.hidden=true;saveButton.disabled=true;preview=null;previewFingerprint='';
    const requestedRevision=revision;
    pendingPreview=true;previewButton.disabled=true;previewButton.textContent='반복 일정 확인 중…';status.textContent='적용할 날짜와 예약 겹침을 확인하고 있어요.';
    try{
      const result=await api(`${API_PATH}/preview`,{method:'POST',body:{...request,...(rule?{id:rule.id,version:rule.version}:{})}});
      if(!current()||requestedRevision!==revision)return;
      preview=result;previewFingerprint=JSON.stringify(request);previewRevision=revision;
      const conflicts=result.conflicts||[],count=result.conflict_count??conflicts.length,occurrences=result.occurrences||[],allowed=result.can_save===true;
      previewArea.classList.toggle('has-conflicts',!allowed);
      previewArea.replaceChildren(el('h3',{},count?'예약과 겹치는 시간이 있어요':'저장할 반복 일정을 확인해 주세요'),el('p',{class:'closure-preview-range'},`${recurrenceSummary(request)} · ${request.start_time}–${request.end_time}`),el('p',{},periodLabel(request)));
      if(request.note)previewArea.append(el('p',{class:'closure-note'},`메모 · ${request.note}`));
      if(count){
        previewArea.append(el('p',{class:'inline-error'},`겹치는 예약 ${count}건이 있어요. 날짜나 시간을 바꾸고 다시 확인해 주세요. 예약은 자동 취소되지 않아요.`),el('ul',{class:'closure-conflicts'},conflicts.map(conflict=>el('li',{},`${dateLabel(conflict.date)} · ${conflict.start_time}–${conflict.end_time}`))));
        if(count>conflicts.length)previewArea.append(el('p',{class:'note'},`총 ${count}건 중 ${conflicts.length}건을 표시해요.`));
      }
      if(occurrences.length)previewArea.append(el('h4',{},'다음 적용 날짜'),el('ul',{class:'recurring-occurrences'},occurrences.map(occurrence=>el('li',{},dateLabel(occurrence.date,true)))),el('p',{class:'note'},'적용 날짜 일부를 보여드려요. 종료일이 없으면 같은 규칙이 계속돼요.'));
      else previewArea.append(el('p',{class:'note'},'표시할 다음 적용 날짜가 없어요. 설정한 기간과 반복 방식을 확인해 주세요.'));
      previewArea.append(el('p',{class:'note'},'저장할 때 예약을 다시 확인해요. 다른 잠금과 겹치면 각각 유지돼요.'));
      previewArea.hidden=false;confirmationArea.hidden=!allowed;saveButton.disabled=!allowed;
      status.textContent=allowed?'내용을 확인한 뒤 반복 잠금을 저장해 주세요.':'현재 내용은 저장할 수 없어요. 설정을 바꾸고 다시 확인해 주세요.';
    }catch(error){if(current()&&requestedRevision===revision){status.textContent='미리보기를 완료하지 못했어요. 다시 시도해 주세요.';showError(error);}}
    finally{pendingPreview=false;if(current()){previewButton.disabled=stale;previewButton.textContent='반복 일정 미리보기';}}
  });
  async function save(){
    if(!current()||saving||pendingPreview||stale||preview?.can_save!==true)return;
    let request;
    try{request=values();}catch(error){invalidate();showError(error);return;}
    const fingerprint=JSON.stringify(request);
    if(previewRevision!==revision||fingerprint!==previewFingerprint){invalidate();status.textContent='내용이 바뀌었어요. 다시 미리보기를 확인한 뒤 저장해 주세요.';return;}
    if(!rule&&!requestIds.has(fingerprint))requestIds.set(fingerprint,createRequestId());
    saving=true;fields.disabled=true;saveButton.disabled=true;previewButton.disabled=true;saveButton.textContent='반복 잠금 저장 중…';content.setAttribute('aria-busy','true');errorArea.replaceChildren();
    try{
      const result=await api(rule?`${API_PATH}/${encodeURIComponent(rule.id)}`:API_PATH,{method:rule?'PUT':'POST',body:{...request,...(rule?{version:rule.version}:{request_id:requestIds.get(fingerprint)})}});
      if(current())onSaved(result);
    }catch(error){
      if(!current())return;
      if(error.status===409){invalidate();status.textContent='미리보기 이후 예약이나 반복 설정이 바뀌었어요. 최신 내용을 확인해 주세요.';}
      else status.textContent=rule?'저장 결과를 확인하지 못했어요. 창을 닫고 목록을 다시 확인해 주세요.':'저장 결과를 확인하지 못했어요. 같은 창에서 같은 내용으로 다시 저장하면 같은 요청 번호로 중복 등록을 막아요.';
      showError(error);
    }finally{
      saving=false;
      if(current()){fields.disabled=false;previewButton.disabled=stale;saveButton.disabled=stale||preview?.can_save!==true;saveButton.textContent='확인한 반복 잠금 저장';content.removeAttribute('aria-busy');}
    }
  }
  openDialog(rule?'반복 잠금 수정':preset==='lunch'?'점심시간 설정':'반복 잠금 등록',content);
  return content;
}

export function createRecurringSection({api,el,field,button,dialog,openDialog,isContextCurrent,onChanged=()=>{}}){
  const count=el('span',{class:'recurring-count'});
  const add=button('＋ 반복 잠금',()=>openEditor(),'secondary small',{disabled:true});
  const lunch=button('점심시간 설정',()=>openEditor(null,'lunch'),'outline small',{disabled:true});
  const reload=button('새로고침',()=>load(),'outline small');
  const list=el('div',{class:'stack recurring-list'},el('p',{class:'loading',role:'status'},'반복 잠금을 불러오는 중…'));
  const capacity=el('p',{class:'note recurring-capacity',hidden:true},'반복 잠금은 최대 32개까지 등록할 수 있어요. 사용하지 않는 규칙을 전체 해제한 뒤 추가해 주세요.');
  const setupNote=el('p',{class:'inline-info',hidden:true},'반복 잠금 설정을 마무리해 주세요. 규칙을 미리본 뒤 저장하면 예약 화면에 적용돼요.');
  const section=el('section',{class:'card recurring-section','aria-labelledby':'recurring-title'},el('div',{class:'card-head'},el('h2',{id:'recurring-title'},'반복 잠금'),add),el('p',{class:'muted'},'점심시간과 정기 휴무를 한 번 정해 두세요. 정해진 날과 시간에 자동으로 예약을 막아요.'),el('div',{class:'recurring-quick'},el('div',{},el('strong',{},'점심시간 빠른 설정'),el('small',{},'매주 월–토 · 13:00–14:00')),lunch),el('div',{class:'recurring-list-head'},count,reload),setupNote,capacity,list,el('p',{class:'note'},'잠금을 해제해도 다른 잠금과 요일 휴무는 유지돼요. ',el('a',{href:'/guide.html#owner-recurring',target:'_blank',rel:'noopener'},'반복 잠금 이용 가이드')));
  let loadRevision=0;
  const current=()=>section.isConnected&&isContextCurrent();
  const refreshed=message=>{dialog.close();void load();onChanged(message);};
  const reloadFromDialog=()=>{dialog.close();void load();};
  function openEditor(rule=null,preset=null){
    if(!current())return;
    showRecurringDialog({api,el,field,button,dialog,openDialog,isContextCurrent:current,rule,preset,onReload:reloadFromDialog,onSaved:()=>refreshed(rule?'반복 잠금을 수정했어요.':'반복 잠금을 등록했어요.')});
  }
  function action({title,message,label,rule,method,path,body,success}){
    if(!current())return;
    const errorArea=el('div');
    const content=el('div',{class:'form-stack recurring-action'},el('p',{},message),el('p',{class:'inline-info'},`${rule.note||'반복 잠금'} · ${recurrenceSummary(rule)} · ${rule.start_time}–${rule.end_time}`),errorArea);
    const active=()=>current()&&dialog.open&&dialog.contains(content);
    let busy=false;
    const accept=button(label,async()=>{
      if(!active()||busy)return;
      busy=true;accept.disabled=true;accept.textContent='처리 중…';errorArea.replaceChildren();
      try{
        await api(path,{method,body:{version:rule.version,...body}});
        if(active())refreshed(success);
      }catch(error){
        if(!active())return;
        errorArea.replaceChildren(el('div',{class:'inline-error',role:'alert',tabindex:'-1'},error.message));errorArea.firstElementChild.focus();
        if(error.code==='stale_version')errorArea.append(button('목록 다시 불러오기',reloadFromDialog,'outline small'));
      }finally{busy=false;if(active()){accept.disabled=false;accept.textContent=label;}}
    });
    content.append(el('div',{class:'dialog-actions'},button('돌아가기',()=>dialog.close(),'outline'),accept));openDialog(title,content);
  }
  function openException(rule){
    if(!current())return;
    const today=seoulToday(),min=rule.start_date>today?rule.start_date:today,max=rule.end_date&&rule.end_date<addDays(today,365)?rule.end_date:addDays(today,365);
    const dateField=field('열어 둘 날짜','exception_date','date',min,{required:true,min,max});
    const dateInput=dateField.querySelector('input');
    const suggestions=el('div',{class:'recurring-exception-suggestions','aria-live':'polite'});
    const errorArea=el('div');
    const submit=el('button',{type:'submit',class:'btn full'},'이 날짜만 열기');
    const content=el('form',{class:'form-stack recurring-exception-form'},el('p',{class:'inline-info'},`${recurrenceSummary(rule)} · ${rule.start_time}–${rule.end_time} 중 하루만 열어요. 다른 날짜의 반복은 유지돼요.`),dateField,suggestions,el('p',{class:'note'},'오늘부터 365일 후까지, 이 규칙이 적용되는 날짜를 선택해 주세요. 다른 잠금이나 요일 휴무는 그대로 적용돼요.'),errorArea,submit,el('div',{class:'dialog-actions'},button('닫기',()=>dialog.close(),'outline')));
    let busy=false,edited=false;
    const active=()=>current()&&dialog.open&&dialog.contains(content);
    dateInput.addEventListener('input',()=>{edited=true;});
    content.addEventListener('submit',async event=>{
      event.preventDefault();if(!active()||busy)return;
      const date=dateInput.value;
      if(!validDate(date)||date<min||date>max){errorArea.replaceChildren(el('div',{class:'inline-error',role:'alert'},'선택할 수 있는 날짜를 확인해 주세요.'));return;}
      busy=true;submit.disabled=true;dateInput.disabled=true;submit.textContent='이 날짜를 여는 중…';errorArea.replaceChildren();
      try{
        await api(`${API_PATH}/${encodeURIComponent(rule.id)}/exceptions/${encodeURIComponent(date)}`,{method:'PUT',body:{version:rule.version}});
        if(active())refreshed(`${dateLabel(date)}의 반복 잠금을 예외로 열었어요.`);
      }catch(error){
        if(active()){errorArea.replaceChildren(el('div',{class:'inline-error',role:'alert',tabindex:'-1'},error.message));errorArea.firstElementChild.focus();if(error.code==='stale_version')errorArea.append(button('목록 다시 불러오기',reloadFromDialog,'outline small'));}
      }finally{busy=false;if(active()){submit.disabled=false;dateInput.disabled=false;submit.textContent='이 날짜만 열기';}}
    });
    openDialog('하루만 열기',content);
    // Suggestions use the server's recurrence calculation, including exceptions.
    const request=normalizeRecurringRequest(rule,{original:rule});
    void api(`${API_PATH}/preview`,{method:'POST',body:{...request,id:rule.id,version:rule.version}}).then(result=>{
      if(!active()||busy)return;
      const upcoming=(result.occurrences||[]).filter(item=>item.date>=min&&item.date<=max&&!rule.exceptions?.includes(item.date)).slice(0,4);
      if(!upcoming.length)return;
      if(!edited)dateInput.value=upcoming[0].date;
      suggestions.replaceChildren(el('p',{class:'note'},'가까운 적용 날짜'),el('div',{class:'actions'},upcoming.map(item=>button(dateLabel(item.date),()=>{if(!busy){dateInput.value=item.date;edited=true;}},'outline small'))));
    }).catch(()=>{/* Date entry remains available if suggestions cannot be loaded. */});
  }
  function paint(items){
    list.replaceChildren();
    const today=seoulToday();
    if(!items.length){list.append(el('div',{class:'empty'},'아직 반복 잠금이 없어요. 점심시간부터 설정해 보세요.'));return;}
    for(const rule of items){
      const path=`${API_PATH}/${encodeURIComponent(rule.id)}`;
      const ended=Boolean(rule.end_date&&rule.end_date<today);
      const status=!rule.enabled?'일시중지':ended?'기간 종료':rule.start_date>today?'시작 예정':'적용 중';
      const row=el('article',{class:'recurring-rule','data-rule-id':rule.id},el('div',{class:'recurring-rule-head'},el('h3',{},rule.note||'반복 잠금'),el('span',{class:`status${!rule.enabled||ended?' pending':''}`},status)),el('p',{class:'recurring-rule-summary'},`${recurrenceSummary(rule)} · ${rule.start_time}–${rule.end_time}`),el('p',{class:'recurring-rule-period'},periodLabel(rule)));
      if(rule.frequency==='biweekly')row.append(el('p',{class:'note recurring-anchor'},`기준 주 · ${dateLabel(mondayOf(rule.start_date),true)} 시작`));
      row.append(el('div',{class:'actions recurring-actions'},
        button('수정',()=>openEditor(rule),'outline small'),
        button(rule.enabled?'일시중지':'재개',()=>action({title:rule.enabled?'반복 잠금 일시중지':'반복 잠금 재개',message:rule.enabled?'이 반복 잠금을 잠시 중지할까요? 등록한 설정과 예외 날짜를 보관해 두고 나중에 재개할 수 있어요.':'같은 설정으로 반복 잠금을 재개할까요? 기존 예약과 겹치면 재개할 수 없어요.',label:rule.enabled?'일시중지하기':'다시 적용하기',rule,method:'PATCH',path,body:{enabled:!rule.enabled},success:rule.enabled?'반복 잠금을 일시중지했어요.':'반복 잠금을 다시 적용했어요.'}),'outline small'),
        button('하루만 열기',()=>openException(rule),'outline small',{disabled:!rule.enabled||ended}),
        button('전체 해제',()=>action({title:'반복 잠금 전체 해제',message:'이 반복 규칙을 전체 해제할까요? 이 규칙으로 앞으로 잠기는 시간을 모두 열어요. 다른 규칙과 이미 확정된 예약은 유지돼요.',label:'반복 잠금 해제하기',rule,method:'DELETE',path,success:'반복 잠금을 전체 해제했어요.'}),'danger small')));
      const exceptions=(rule.exceptions||[]).filter(date=>date>=today).sort();
      if(exceptions.length){
        const exceptionRows=exceptions.map(date=>el('li',{'data-exception-date':date},el('span',{},dateLabel(date,true)),button('다시 잠그기',()=>action({title:'예외 날짜 다시 잠그기',message:`${dateLabel(date)}의 예외를 없앨까요? 적용 중인 규칙은 기존 예약과 겹치면 복원할 수 없어요. 일시중지한 규칙은 재개할 때 적용돼요.`,label:'예외 해제하기',rule,method:'DELETE',path:`${path}/exceptions/${encodeURIComponent(date)}`,success:'예외 날짜를 해제했어요. 반복 규칙의 적용 상태는 그대로 유지돼요.'}),'outline small',{'aria-label':`${dateLabel(date)} 다시 잠그기`})));
        row.append(el('details',{class:'recurring-exceptions'},el('summary',{},`예외로 연 날짜 ${exceptions.length}일 · 다시 잠그기`),el('p',{class:'note'},'예외는 이 반복 규칙에만 적용돼요.'),el('ul',{},exceptionRows)));
      }
      list.append(row);
    }
  }
  async function load(){
    const revision=++loadRevision;reload.disabled=true;add.disabled=true;lunch.disabled=true;
    try{
      const result=await api(API_PATH);
      if(!current()||revision!==loadRevision)return;
      const items=result.items||[];paint(items);count.textContent=`등록된 반복 잠금 ${items.length}개`;capacity.hidden=items.length<32;add.disabled=items.length>=32;lunch.disabled=items.length>=32;setupNote.hidden=result.schema_ready!==false||!items.length;
    }catch(error){
      if(current()&&revision===loadRevision){list.replaceChildren(el('div',{class:'inline-error',role:'alert'},error.message),el('p',{class:'note'},'반복 잠금을 불러오지 못했어요. 새로고침으로 다시 확인해 주세요.'));count.textContent='확인 필요';}
    }finally{if(current()&&revision===loadRevision)reload.disabled=false;}
  }
  void load();return section;
}
