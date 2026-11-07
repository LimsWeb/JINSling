const search=document.querySelector('#guide-search');
const result=document.querySelector('#guide-results');
const tabs=[...document.querySelectorAll('[data-guide-view]')];
const panels=[...document.querySelectorAll('.guide-panel')];
const topics=[...document.querySelectorAll('.guide-topic')];
const toc=document.querySelector('#guide-toc');
const empty=document.querySelector('#guide-empty');
const print=document.querySelector('#guide-print');
let audience='member';

const normalized=value=>value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g,' ').trim();
const index=new Map(topics.map(topic=>[topic,normalized(`${topic.textContent} ${topic.dataset.keywords||''}`)]));
function render(){
  const terms=normalized(search.value).split(' ').filter(Boolean);
  const panel=document.querySelector(`#${audience}`);
  const available=[...panel.querySelectorAll('.guide-topic')];
  const matches=available.filter(topic=>terms.every(term=>index.get(topic).includes(term)));
  for(const item of panels)item.hidden=item!==panel;
  for(const topic of topics)topic.hidden=!matches.includes(topic);
  for(const tab of tabs){
    const active=tab.dataset.guideView===audience;
    tab.classList.toggle('active',active);
    if(active)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');
  }
  toc.replaceChildren(...matches.map(topic=>{
    const link=document.createElement('a');link.href=`#${topic.id}`;link.textContent=topic.querySelector('h3').textContent;return link;
  }));
  const label=audience==='owner'?'사장님 안내':'회원 안내';
  result.textContent=terms.length?`${label}에서 ${matches.length}개를 찾았어요. 다른 이용자 안내도 선택할 수 있어요.`:`${label} ${available.length}개 · 제목을 눌러 이동할 수 있어요.`;
  empty.hidden=matches.length>0;
  print.textContent=`${audience==='owner'?'사장님':'회원'} 안내 인쇄`;
}
function followHash(){
  const target=document.getElementById(window.location.hash.slice(1));
  if(target){
    const panel=target.matches('.guide-panel')?target:target.closest('.guide-panel');
    if(panel){audience=panel.id;if(target.matches('.guide-topic'))search.value='';}
  }
  render();
  if(target?.matches('.guide-topic'))requestAnimationFrame(()=>target.scrollIntoView({block:'start'}));
}
for(const tab of tabs)tab.addEventListener('click',event=>{
  event.preventDefault();audience=tab.dataset.guideView;
  history.replaceState(null,'',`#${audience}`);render();
});
search.disabled=false;
search.addEventListener('input',render);
print.hidden=false;
print.addEventListener('click',()=>window.print());
window.addEventListener('hashchange',followHash);
followHash();
