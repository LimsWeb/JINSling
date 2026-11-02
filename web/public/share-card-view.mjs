import {prepareShareCard} from './share-card.mjs';
import {copyShareText} from './share-link.mjs';

const INK='#174d46';

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}

function openLink(url,className){
  const link=element('a',className);
  // Keep the exact input, including a one-time invitation fragment. Do not
  // normalize, shorten or reconstruct it from the URL parser.
  link.setAttribute('href',url);
  link.target='_blank';
  link.rel='noopener noreferrer';
  return link;
}

function qrCanvas(qr,label){
  const quiet=4;
  const moduleSize=Math.ceil(600/(qr.size+quiet*2));
  const canvas=element('canvas','share-card-qr');
  canvas.width=canvas.height=(qr.size+quiet*2)*moduleSize;
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',label);
  canvas.dataset.qrOnly='true';
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('Canvas is unavailable.');
  context.fillStyle='#fff';
  context.fillRect(0,0,canvas.width,canvas.height);
  context.imageSmoothingEnabled=false;
  context.fillStyle=INK;
  for(let row=0;row<qr.size;row++)for(let column=0;column<qr.size;column++){
    if(qr.getModule(column,row))context.fillRect(
      (column+quiet)*moduleSize,(row+quiet)*moduleSize,moduleSize,moduleSize,
    );
  }
  return canvas;
}

/**
 * One visual card with a real link above a QR-only canvas. Load the companion
 * share-card-view.css stylesheet; PNG export remains in share-card.mjs.
 * All contents and QR generation stay in this browser, with no network calls.
 */
export function createInteractiveShareCard(options){
  const card=prepareShareCard(options);
  if(!globalThis.document?.createElement)throw new Error('브라우저에서 안내 카드를 열어 주세요.');
  const invitation=card.kind==='invite';
  const article=element('article','interactive-share-card');
  article.setAttribute('aria-label',invitation?'가입 초대 안내 카드':'예약 안내 카드');

  const header=element('header','share-card-heading');
  header.append(
    element('p','share-card-shop',card.shopName),
    element('h3','share-card-title',invitation?'가입 초대':'예약과 내 일정, 여기에서'),
    element('p','share-card-instruction','주소를 누르거나 QR을 스캔해 주세요.'),
  );

  const address=element('div','share-card-address');
  const addressHeading=element('div','share-card-address-heading');
  const copyButton=element('button','share-card-copy','링크 복사');
  copyButton.type='button';
  addressHeading.append(element('span','share-card-address-label',invitation?'초대 주소':'예약 주소'),copyButton);
  const link=openLink(card.url,'share-link-anchor');
  link.textContent=card.url;
  link.setAttribute('aria-label',`${invitation?'초대':'예약'} 주소: ${card.url} (새 탭)`);

  const manual=element('details','share-manual');
  const summary=element('summary',null,'직접 주소 복사하기');
  const fieldLabel=element('label','share-card-manual-label');
  const input=element('textarea','share-url');
  input.readOnly=true;
  input.value=card.url;
  input.rows=3;
  input.spellcheck=false;
  input.setAttribute('autocapitalize','off');
  fieldLabel.append(element('span',null,'복사할 주소'),input);
  manual.append(summary,fieldLabel,
    element('p','share-card-manual-help','주소를 길게 누르거나 전체 선택한 뒤 복사해 주세요.'),
  );
  const feedback=element('p','share-card-copy-feedback');
  feedback.setAttribute('role','status');
  feedback.setAttribute('aria-live','polite');
  address.append(addressHeading,link,manual,feedback);

  copyButton.addEventListener('click',async()=>{
    const wasOpen=manual.open;
    // The legacy copy path needs a visible field. Keep it open and selected if
    // the browser blocks automatic copying, including in embedded browsers.
    manual.open=true;
    copyButton.disabled=true;
    copyButton.setAttribute('aria-busy','true');
    try{
      const result=await copyShareText(card.url,{selectionInput:input});
      if(result==='copied'){
        manual.open=wasOpen;
        feedback.textContent='주소를 복사했어요.';
      }else{
        feedback.textContent='주소를 선택했어요. 길게 누르거나 Ctrl+C로 복사해 주세요.';
      }
    }finally{
      copyButton.disabled=false;
      copyButton.removeAttribute('aria-busy');
    }
  });

  const qrArea=element('div','share-card-qr-area');
  try{
    const qrLink=openLink(card.url,'share-card-preview');
    qrLink.setAttribute('aria-label',invitation?'QR을 눌러 초대 주소 열기 (새 탭)':'QR을 눌러 예약 페이지 열기 (새 탭)');
    qrLink.append(qrCanvas(card.qr,invitation?'가입 초대 주소의 QR 코드':'예약 주소의 QR 코드'));
    qrArea.append(qrLink,element('p','share-card-qr-help','휴대폰 카메라로 QR을 비춰 주세요.'));
  }catch{
    // A working address is more useful than hiding the whole card when canvas
    // is disabled by a browser. Never leave an empty canvas posing as a QR.
    qrArea.append(element('p','share-card-qr-unavailable','QR을 표시할 수 없어요. 위의 주소로 접속해 주세요.'));
  }

  const footer=element('footer','share-card-footer');
  if(invitation){
    footer.append(
      element('p','share-card-approval','한 번만 사용할 수 있는 초대예요.'),
      element('p','share-card-expiry',`사용 기한 · ${card.expiryLabel} (서울)`),
      element('p','share-card-footer-note','가입 후 매장 승인이 필요해요.'),
    );
  }else{
    footer.append(element('p','share-card-approval','가입 후 매장 승인 한 번이면 이용할 수 있어요.'));
  }
  article.append(header,address,qrArea,footer);
  return article;
}
