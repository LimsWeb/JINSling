import {addDays,createRequestId,dateLabel,seoulToday} from './ui-utils.mjs';

export const CLOSURE_PERIODS = Object.freeze({
  day:{label:'하루',start_time:'00:00',end_time:'24:00'},
  morning:{label:'오전',start_time:'00:00',end_time:'12:00'},
  afternoon:{label:'오후',start_time:'12:00',end_time:'24:00'},
  custom:{label:'직접 지정'},
});

function validDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function timeMinutes(value,allowEnd=false){
  if(allowEnd&&value==='24:00')return 1440;
  if(typeof value!=='string'||!/^([01]\d|2[0-3]):(00|30)$/.test(value))return NaN;
  const [hours,minutes]=value.split(':').map(Number);
  return hours*60+minutes;
}
export function normalizeClosureRequest(values,today=seoulToday()){
  const {from,to,period}=values;
  if(!validDate(from)||!validDate(to))throw new Error('시작일과 종료일을 올바르게 선택해 주세요.');
  if(from<today||to>addDays(today,365))throw new Error('오늘부터 365일 후까지의 날짜를 선택해 주세요.');
  if(from>to)throw new Error('종료일을 시작일과 같거나 이후로 선택해 주세요.');
  if((new Date(`${to}T12:00:00Z`)-new Date(`${from}T12:00:00Z`))/86400000>=31)throw new Error('한 번에 최대 31일을 잠글 수 있어요. 날짜 범위를 줄여 주세요.');
  if(!Object.hasOwn(CLOSURE_PERIODS,period))throw new Error('잠글 시간대를 선택해 주세요.');
  const request={from,to,period,note:String(values.note||'').trim()};
  if(Array.from(request.note).length>500)throw new Error('잠금 메모는 500자 이내로 입력해 주세요.');
  if(period==='custom'){
    const start=timeMinutes(values.start_time),end=timeMinutes(values.end_time,true);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new Error('시작보다 늦은 종료 시간을 30분 단위로 선택해 주세요.');
    request.start_time=values.start_time;request.end_time=values.end_time;
  }
  return request;
}
export function groupClosureBlocks(items){
  const groups=new Map();
  for(const block of items){
    const key=block.batch_id?`batch:${block.batch_id}`:`single:${block.id}`;
    if(!groups.has(key))groups.set(key,{batch_id:block.batch_id||null,items:[]});
    groups.get(key).items.push(block);
  }
  return [...groups.values()].map(group=>({...group,items:group.items.sort((a,b)=>`${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`))}));
}

export function showClosureDialog({api,el,field,button,dialog,openDialog,isContextCurrent,onSaved,defaultDate}){
  const today=seoulToday(),last=addDays(today,365);
  const initialDate=validDate(defaultDate)&&defaultDate>=today&&defaultDate<=last?defaultDate:today;
  const from=field('시작일','from','date',initialDate,{required:true,min:today,max:last});
  const to=field('종료일','to','date',initialDate,{required:true,min:today,max:last});
  const presets=el('fieldset',{class:'closure-presets'},el('legend',{},'잠글 시간대'));
  for(const [value,preset] of Object.entries(CLOSURE_PERIODS)){
    presets.append(el('label',{class:'closure-preset'},el('input',{type:'radio',name:'period',value,checked:value==='day'}),el('span',{},el('strong',{},preset.label),el('small',{},preset.start_time?`${preset.start_time}–${preset.end_time}`:'30분 단위'))));
  }
  const timeSelect=(name,label,selected,end=false)=>{
    const select=el('select',{name,disabled:true,required:true});
    for(let minutes=0;minutes<=(end?1440:1410);minutes+=30){
      const value=`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
      select.append(el('option',{value},value==='24:00'?'24:00 · 하루 끝':value));
    }
    select.value=selected;
    return el('label',{},label,select);
  };
  const custom=el('div',{class:'field-row closure-custom',hidden:true},timeSelect('start_time','시작 시간','12:00'),timeSelect('end_time','종료 시간','13:00',true));
  const fields=el('fieldset',{class:'closure-fields'},el('legend',{class:'visually-hidden'},'휴무 잠금 내용'),el('div',{class:'field-row closure-date-row'},from,to),presets,custom,field('잠금 메모 (선택)','note','textarea','',{maxlength:500,placeholder:'예: 매장 휴무, 점심시간, 개인 일정'}));
  const errorArea=el('div');
  const previewArea=el('section',{class:'closure-preview',hidden:true,'aria-live':'polite','aria-atomic':'true'});
  const previewButton=el('button',{type:'submit',class:'btn secondary full'},'잠금 내용 미리보기');
  const saveButton=button('확인한 내용으로 잠금 저장',save,'full',{disabled:true});
  const confirmationArea=el('div',{class:'closure-confirmation',hidden:true},saveButton);
  const status=el('p',{class:'note closure-status',role:'status'});
  const content=el('form',{class:'form-stack closure-form'},el('p',{class:'inline-info'},'하루 또는 반나절을 여러 날짜에 한 번에 잠가요. 기존 예약과 겹치면 전체를 저장하지 않아요.'),fields,el('p',{class:'note',id:'closure-limits'},'서울 날짜 기준 · 오늘부터 365일 후까지 · 한 번에 최대 31일. 하루 잠금은 00:00부터 24:00까지예요.'),errorArea,previewButton,status,previewArea,confirmationArea,el('div',{class:'dialog-actions'},button('닫기',()=>dialog.close(),'outline')));
  fields.setAttribute('aria-describedby','closure-limits');
  let revision=0,preview=null,previewFingerprint='',previewRevision=-1,pendingPreview=false,saving=false;
  const requestIds=new Map();
  const current=()=>dialog.open&&dialog.contains(content)&&isContextCurrent();
  const values=()=>normalizeClosureRequest(Object.fromEntries(new FormData(content)));
  const showError=error=>{
    errorArea.replaceChildren(el('div',{class:'inline-error',role:'alert',tabindex:'-1'},error.message));
    errorArea.firstElementChild.focus();
  };
  const invalidate=()=>{
    revision++;
    const hadPreview=Boolean(preview)||pendingPreview;
    preview=null;previewFingerprint='';previewRevision=-1;
    previewArea.hidden=true;previewArea.replaceChildren();confirmationArea.hidden=true;saveButton.disabled=true;
    if(hadPreview)status.textContent='선택 내용이 바뀌었어요. 잠금 내용을 다시 미리보기 해 주세요.';
  };
  fields.addEventListener('input',()=>{if(!saving)invalidate();});
  fields.addEventListener('change',()=>{
    const isCustom=content.elements.period.value==='custom';
    custom.hidden=!isCustom;
    for(const select of custom.querySelectorAll('select'))select.disabled=!isCustom;
    if(!saving)invalidate();
  });
  content.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!current()||pendingPreview||saving)return;
    let request;
    try{request=values();}catch(error){invalidate();showError(error);return;}
    errorArea.replaceChildren();previewArea.hidden=true;confirmationArea.hidden=true;saveButton.disabled=true;
    preview=null;previewFingerprint='';
    const requestedRevision=revision;
    pendingPreview=true;previewButton.disabled=true;previewButton.textContent='예약 겹침 확인 중…';
    status.textContent='선택한 날짜의 예약을 확인하고 있어요.';
    try{
      const result=await api('/admin/blocks/preview',{method:'POST',body:request});
      if(!current()||requestedRevision!==revision)return;
      preview=result;previewFingerprint=JSON.stringify(request);previewRevision=revision;
      const conflicts=result.conflicts||[];
      const range=result.from===result.to?dateLabel(result.from,true):`${dateLabel(result.from,true)} – ${dateLabel(result.to,true)}`;
      previewArea.replaceChildren(el('h3',{},conflicts.length?'예약과 겹치는 시간이 있어요':'저장할 잠금을 확인해 주세요'),el('p',{class:'closure-preview-range'},range),el('p',{},`총 ${result.count}일 · 매일 ${result.start_time}–${result.end_time}`));
      if(request.note)previewArea.append(el('p',{class:'closure-note'},`메모 · ${request.note}`));
      if(conflicts.length){
        previewArea.classList.add('has-conflicts');
        previewArea.append(el('p',{class:'inline-error'},'아래 예약과 겹쳐 전체 잠금을 저장할 수 없어요. 날짜나 시간을 바꾸고 다시 확인해 주세요. 예약은 자동 취소되지 않아요.'),el('ul',{class:'closure-conflicts'},conflicts.map(conflict=>el('li',{},`${dateLabel(conflict.date)} · ${conflict.start_time}–${conflict.end_time}`))));
        status.textContent=`겹치는 예약 ${conflicts.length}건을 확인했어요.`;
      }else{
        previewArea.classList.remove('has-conflicts');
        const dates=el('details',{class:'closure-dates'},el('summary',{},`대상 날짜 ${result.count}일 모두 보기`),el('ul',{},result.dates.map(date=>el('li',{},dateLabel(date,true)))));
        previewArea.append(dates,el('p',{class:'note'},'저장할 때 예약을 한 번 더 확인해요. 다른 잠금과 겹쳐도 각각 유지되며, 이 묶음을 해제해도 다른 잠금은 남아요.'));
        confirmationArea.hidden=false;saveButton.disabled=false;status.textContent='겹치는 예약이 없어요. 내용을 확인한 뒤 저장해 주세요.';
      }
      previewArea.hidden=false;
    }catch(error){if(current()&&requestedRevision===revision){status.textContent='미리보기를 완료하지 못했어요. 다시 시도해 주세요.';showError(error);}}
    finally{pendingPreview=false;if(current()){previewButton.disabled=false;previewButton.textContent='잠금 내용 미리보기';}}
  });
  async function save(){
    if(!current()||saving||pendingPreview||!preview||preview.conflicts?.length)return;
    let request;
    try{request=values();}catch(error){invalidate();showError(error);return;}
    const fingerprint=JSON.stringify(request);
    if(previewRevision!==revision||fingerprint!==previewFingerprint){invalidate();status.textContent='내용이 바뀌었어요. 다시 미리보기를 확인한 뒤 저장해 주세요.';return;}
    if(!requestIds.has(fingerprint))requestIds.set(fingerprint,createRequestId());
    saving=true;fields.disabled=true;saveButton.disabled=true;previewButton.disabled=true;
    saveButton.textContent='잠금 저장 중…';content.setAttribute('aria-busy','true');errorArea.replaceChildren();
    try{
      const result=await api('/admin/blocks/bulk',{method:'POST',body:{...request,request_id:requestIds.get(fingerprint)}});
      if(current())onSaved(result);
    }catch(error){
      if(!current())return;
      if(error.status===409){invalidate();status.textContent='미리보기 이후 예약이나 운영 상태가 바뀌었어요. 다시 미리보기를 확인해 주세요.';}
      else status.textContent='저장 결과를 확인하지 못했어요. 같은 내용으로 다시 저장하면 같은 요청 번호를 사용해 중복 등록을 막아요.';
      showError(error);
    }finally{
      saving=false;
      if(current()){
        fields.disabled=false;previewButton.disabled=false;saveButton.disabled=!preview||Boolean(preview.conflicts?.length);
        saveButton.textContent='확인한 내용으로 잠금 저장';content.removeAttribute('aria-busy');
      }
    }
  }
  openDialog('휴무 · 시간 잠금',content);
  return content;
}
