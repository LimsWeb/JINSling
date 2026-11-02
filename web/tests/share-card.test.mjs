import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareShareCard,wrapCardText,shareCardBlob} from '../public/share-card.mjs';

const invitation='https://studio.example/예약?source=안내%20카드&name=%26%3C#invite=Ab_12-xy%2Bsecret%3D';
const expiry='2026-11-09 09:30:00';

test('invitation cards retain the exact full URL and use the real Seoul expiry',()=>{
  const card=prepareShareCard({url:invitation,shopName:'진슬링 <&> 🌿',kind:'invite',expiresAt:expiry});
  assert.equal(card.url,invitation);
  assert.equal(card.shopName,'진슬링 <&> 🌿');
  assert.match(card.expiryLabel,/2026/);
  assert.match(card.expiryLabel,/11/);
  assert.match(card.expiryLabel,/09/);
  assert.match(card.expiryLabel,/18:30/);
  assert.equal(card.qr.size>=21,true);
});

test('reusable public cards cannot accidentally contain invitation or password-reset fragments',()=>{
  const card=prepareShareCard({url:'https://studio.example/',shopName:'',kind:'public'});
  assert.equal(card.url,'https://studio.example/');
  assert.equal(card.shopName,'jinSling');
  for(const hash of ['#invite=private','#reset=private','#other']){
    assert.throws(()=>prepareShareCard({url:`https://studio.example/${hash}`,kind:'public'}),/공개/);
  }
});

test('unsafe or unusable links and missing invitation expiry are refused before drawing',()=>{
  for(const url of ['javascript:alert(1)','data:text/html,hello','/relative','https:studio.example/','https:\\studio.example/','https://name:secret@studio.example/','https://studio.example/\n#invite=secret']){
    assert.throws(()=>prepareShareCard({url,kind:'public'}),/주소/);
  }
  assert.throws(()=>prepareShareCard({url:'https://studio.example/',kind:'unknown'}),/종류/);
  assert.throws(()=>prepareShareCard({url:'https://studio.example/',kind:'invite',expiresAt:expiry}),/초대/);
  assert.throws(()=>prepareShareCard({url:invitation,kind:'invite'}),/기한/);
  assert.throws(()=>prepareShareCard({url:invitation,kind:'invite',expiresAt:'not-a-date'}),/기한/);
  assert.throws(()=>prepareShareCard({url:invitation+'&reset=another',kind:'invite',expiresAt:expiry}),/초대/);
});

test('URL density is bounded by UTF8 bytes without shortening an accepted link',()=>{
  const prefix='https://studio.example/';
  const limitUrl=prefix+'a'.repeat(512-prefix.length);
  assert.equal(prepareShareCard({url:limitUrl,kind:'public'}).url,limitUrl);
  assert.throws(()=>prepareShareCard({url:limitUrl+'a',kind:'public'}),/길/);
  const unicode=prefix+'가'.repeat(170);
  assert.equal(unicode.length<512,true);
  assert.throws(()=>prepareShareCard({url:unicode,kind:'public'}),/길/);
});

test('line wrapping keeps every URL character and complete grapheme clusters',()=>{
  const measure=text=>Array.from(text).length*10;
  const lines=wrapCardText(invitation,90,measure);
  assert.equal(lines.join(''),invitation);
  assert.equal(lines.every(line=>measure(line)<=90),true);
  assert.deepEqual(wrapCardText('a👩‍💻éb',40,measure),['a👩‍💻','éb']);
  assert.throws(()=>wrapCardText('가',5,measure),/폭/);
});

test('PNG conversion requests an image and reports a failed browser encoding',async()=>{
  const expected=new Blob(['png-data'],{type:'image/png'});
  const canvas={toBlob(callback,type){assert.equal(type,'image/png');callback(expected);}};
  assert.equal(await shareCardBlob(canvas),expected);
  await assert.rejects(shareCardBlob({toBlob(callback){callback(null);}}),/이미지/);
});
