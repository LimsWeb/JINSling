import {qrcodegen} from './vendor/qrcodegen-v1.8.0.mjs';
import {parseTimestamp} from './ui-utils.mjs';

const SIZE=1080;
const FONT="Arial, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
const INK='#174d46';
const MUTED='#617367';
const encoder=new TextEncoder();

// Validate before creating a canvas. The original URL, including its fragment,
// is encoded unchanged; parsing is only used to reject unsuitable links.
export function prepareShareCard({url,shopName='jinSling',kind='public',expiresAt}={}){
  if(!['public','invite'].includes(kind))throw new Error('안내 이미지 종류를 확인해 주세요.');
  if(typeof url!=='string'||!/^https?:\/\//iu.test(url)||/[\u0000-\u0020\u007f\\]/u.test(url)||Array.from(url).some(char=>{
    const point=char.codePointAt(0);return point>=0xd800&&point<=0xdfff;
  }))throw new Error('안내할 주소를 확인해 주세요.');
  let parsed;
  try{parsed=new URL(url);}catch{throw new Error('안내할 주소를 확인해 주세요.');}
  if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('안내할 주소를 확인해 주세요.');
  const bytes=encoder.encode(url);
  // A smaller bound than QR's theoretical capacity keeps a 1080px card readable.
  if(bytes.length>512)throw new Error('주소가 너무 길어 안내 이미지를 만들 수 없어요. 짧은 예약 주소를 사용해 주세요.');
  const fragments=new URLSearchParams(parsed.hash.slice(1));
  if(kind==='public'&&parsed.hash)throw new Error('공개 예약 이미지에는 초대나 비밀번호 재설정 주소를 사용할 수 없어요.');
  let expiryLabel=null;
  if(kind==='invite'){
    if(!fragments.get('invite')||fragments.has('reset'))throw new Error('한 번 사용할 초대 주소를 확인해 주세요.');
    const expiry=typeof expiresAt==='string'?parseTimestamp(expiresAt):new Date(NaN);
    if(Number.isNaN(expiry.getTime()))throw new Error('초대 링크의 사용 기한을 확인해 주세요.');
    expiryLabel=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(expiry);
  }
  const name=typeof shopName==='string'?shopName.trim().replace(/\s+/gu,' '):'';
  if(Array.from(name).length>80)throw new Error('매장 이름은 80자 이내로 입력해 주세요.');
  // ECI 26 explicitly identifies UTF-8 for Korean paths/names and special text.
  const qr=qrcodegen.QrCode.encodeSegments([
    qrcodegen.QrSegment.makeEci(26),qrcodegen.QrSegment.makeBytes(bytes)
  ],qrcodegen.QrCode.Ecc.MEDIUM);
  return {url,shopName:name||'jinSling',kind,expiryLabel,qr};
}

export function wrapCardText(text,maxWidth,measure){
  const characters=typeof Intl.Segmenter==='function'
    ? Array.from(new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text),part=>part.segment)
    : Array.from(text);
  const lines=[];let line='';
  for(const character of characters){
    if(measure(character)>maxWidth)throw new Error('문구를 표시할 폭이 부족해요.');
    if(line&&measure(line+character)>maxWidth){lines.push(line);line=character;}
    else line+=character;
  }
  if(line)lines.push(line);
  return lines;
}

function fitText(context,text,{maxWidth=936,maxLines=1,maxHeight=Infinity,size=26,minSize=18,weight=400}={}){
  for(let fontSize=size;fontSize>=minSize;fontSize-=2){
    context.font=`${weight} ${fontSize}px ${FONT}`;
    const lines=wrapCardText(text,maxWidth,value=>context.measureText(value).width);
    if(lines.length<=maxLines&&lines.length*Math.ceil(fontSize*1.3)<=maxHeight)return {lines,size:fontSize,weight};
  }
  throw new Error('주소나 문구가 너무 길어 이미지에 담을 수 없어요. 짧은 주소를 사용해 주세요.');
}

function drawLines(context,layout,y,color=INK){
  context.fillStyle=color;
  context.font=`${layout.weight} ${layout.size}px ${FONT}`;
  const lineHeight=Math.ceil(layout.size*1.3);
  for(const line of layout.lines){context.fillText(line,SIZE/2,y);y+=lineHeight;}
  return y;
}

/** Draw a shareable PNG preview entirely in this browser, without network calls. */
export async function renderShareCard(options){
  const card=prepareShareCard(options);
  if(!globalThis.document?.createElement)throw new Error('브라우저에서 안내 이미지를 만들어 주세요.');
  if(document.fonts?.ready)await document.fonts.ready;
  const canvas=document.createElement('canvas');
  canvas.width=SIZE;canvas.height=SIZE;
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('이 브라우저에서 안내 이미지를 만들 수 없어요.');
  context.fillStyle='#f7f7f0';context.fillRect(0,0,SIZE,SIZE);
  context.fillStyle=INK;context.fillRect(64,24,SIZE-128,5);
  context.textAlign='center';context.textBaseline='top';context.direction='ltr';
  let y=drawLines(context,fitText(context,card.shopName,{size:34,minSize:22,maxLines:2,weight:600}),56);
  y=drawLines(context,fitText(context,card.kind==='invite'?'가입 초대':'예약과 내 일정, 여기에서',{size:50,minSize:34,weight:700}),y+14);
  y=drawLines(context,{lines:[card.kind==='invite'?'초대 주소':'예약 주소'],size:20,weight:600},y+16,MUTED);
  const link=fitText(context,card.url,{maxWidth:900,maxLines:8,maxHeight:156,size:26,minSize:18});
  y+=10;
  context.fillStyle='#eaf0e7';
  context.fillRect(64,y-7,SIZE-128,link.lines.length*Math.ceil(link.size*1.3)+14);
  y=drawLines(context,link,y);

  // Integer modules and at least four completely white modules on every side.
  // There is no logo, image overlay, anti-aliased resizing or rounded QR cell.
  const quiet=4;
  const target=Math.min(600,914-(y+28));
  const moduleSize=Math.floor(target/(card.qr.size+quiet*2));
  if(moduleSize<4)throw new Error('주소가 너무 길어 선명한 QR 이미지를 만들 수 없어요.');
  const qrSize=(card.qr.size+quiet*2)*moduleSize;
  const x=Math.floor((SIZE-qrSize)/2);
  const top=Math.floor(((y+28)+914-qrSize)/2);
  context.fillStyle='#fff';context.fillRect(x-14,top-14,qrSize+28,qrSize+28);
  context.strokeStyle='#dce2d8';context.lineWidth=1;
  context.strokeRect(x-14.5,top-14.5,qrSize+29,qrSize+29);
  context.imageSmoothingEnabled=false;context.fillStyle=INK;
  for(let row=0;row<card.qr.size;row++)for(let column=0;column<card.qr.size;column++){
    if(card.qr.getModule(column,row))context.fillRect(x+(column+quiet)*moduleSize,top+(row+quiet)*moduleSize,moduleSize,moduleSize);
  }
  if(card.kind==='invite'){
    drawLines(context,fitText(context,'발급 후 7일 · 한 번만 사용',{size:26,weight:600}),950);
    drawLines(context,fitText(context,`사용 기한 · ${card.expiryLabel} (서울)`,{size:22}),990,MUTED);
    drawLines(context,fitText(context,'가입 후 매장 승인이 필요해요.',{size:20}),1024,MUTED);
  }else{
    drawLines(context,fitText(context,'가입 후 매장 승인 한 번이면 이용할 수 있어요.',{size:26,minSize:22,weight:600}),954);
    drawLines(context,fitText(context,'휴대폰 카메라로 QR을 비춰 주세요.',{size:23,minSize:19}),1000,MUTED);
  }
  return canvas;
}

export function shareCardBlob(canvas){
  return new Promise((resolve,reject)=>{
    if(typeof canvas?.toBlob!=='function'){reject(new Error('안내 이미지를 저장할 수 없어요.'));return;}
    canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('안내 이미지를 저장하지 못했어요. 다시 시도해 주세요.')),'image/png');
  });
}
