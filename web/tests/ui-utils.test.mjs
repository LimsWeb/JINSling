import test from 'node:test';
import assert from 'node:assert/strict';
import {seoulToday,addDays,extractInvite,canCustomerChange,parseTimestamp,createRequestId} from '../public/ui-utils.mjs';
import * as accountUi from '../public/ui-utils.mjs';

test('booking dates use Seoul even before UTC midnight',()=>{
  assert.equal(seoulToday(new Date('2026-10-30T16:00:00Z')),'2026-10-31');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.equal(addDays('2028-02-28',1),'2028-02-29');
});
test('invite secret is read and immediately removed from address',()=>{
  let replaced;
  const token=extractInvite({hash:'#invite=private%2Btoken',pathname:'/',search:'?safe=1'},{replaceState(...args){replaced=args;}});
  assert.equal(token,'private+token');
  assert.deepEqual(replaced,[null,'','/?safe=1']);
});
test('reset and invitation fragments are consumed together before returning either secret',()=>{
  const location={hash:'#invite=optional%2Binvite&reset=private%2Freset%3D',pathname:'/booking/',search:'?safe=1'};
  let cleared=false;
  const tokens=accountUi.consumeAuthFragment(location,{replaceState(state,title,url){
    assert.equal(url,'/booking/?safe=1');
    assert.equal(state,null);
    assert.equal(title,'');
    cleared=true;
  }});
  assert.equal(cleared,true);
  assert.deepEqual(tokens,{inviteToken:'optional+invite',resetToken:'private/reset='});
});
test('empty secret fragments are cleared while unrelated anchors are left alone',()=>{
  let replacements=0;
  const history={replaceState(){replacements++;}};
  assert.deepEqual(accountUi.consumeAuthFragment({hash:'#reset=',pathname:'/',search:''},history),{inviteToken:null,resetToken:''});
  assert.equal(replacements,1);
  assert.deepEqual(accountUi.consumeAuthFragment({hash:'#help',pathname:'/',search:''},history),{inviteToken:null,resetToken:null});
  assert.equal(replacements,1);
});
test('same-document secret navigation clears each fragment before notifying the app and ignores unrelated anchors',()=>{
  const browser=new EventTarget();
  browser.location={hash:'',pathname:'/',search:'?view=booking'};
  const notifications=[];
  browser.history={replaceState(state,title,url){
    assert.equal(url,'/?view=booking');
    browser.location.hash='';
  }};
  accountUi.listenForAuthFragments(browser,tokens=>{
    assert.equal(browser.location.hash,'');
    notifications.push(tokens);
  });
  for(const hash of ['#reset=first%2Btoken','#reset=second%2Ftoken','#help','#invite=new%3Dinvitation']){
    browser.location.hash=hash;
    browser.dispatchEvent(new Event('hashchange'));
  }
  assert.deepEqual(notifications,[
    {inviteToken:null,resetToken:'first+token'},
    {inviteToken:null,resetToken:'second/token'},
    {inviteToken:'new=invitation',resetToken:null}
  ]);
});
test('usernames normalize case and surrounding space but reject unsafe or ambiguous characters',()=>{
  assert.equal(accountUi.normalizeUsername('  Jin_Sling01  '),'jin_sling01');
  assert.equal(accountUi.normalizeUsername('A'.repeat(32)),'a'.repeat(32));
  for(const input of ['abc','a'.repeat(33),'한글사용자','name space','name@example.com','user-name','ｕｓｅｒ','user\nname']){
    assert.throws(()=>accountUi.normalizeUsername(input),/아이디/);
  }
});
test('new passwords preserve Unicode and spaces and count characters rather than UTF16 units',()=>{
  const password='  나의 긴 비밀번호 🌿🌿🌿🌿  ';
  assert.equal(accountUi.validateNewPassword(password,password),password);
  assert.equal(accountUi.validateNewPassword('🌿'.repeat(15),'🌿'.repeat(15)),'🌿'.repeat(15));
  assert.equal(accountUi.validateNewPassword('🌿'.repeat(128),'🌿'.repeat(128)),'🌿'.repeat(128));
  assert.throws(()=>accountUi.validateNewPassword('🌿'.repeat(14),'🌿'.repeat(14)),/15/);
  assert.throws(()=>accountUi.validateNewPassword('a'.repeat(129),'a'.repeat(129)),/128/);
});
test('password confirmation is exact and errors never include a password value',()=>{
  const password='sensitive password 🌿';
  assert.throws(()=>accountUi.validateNewPassword(password,`${password} `),error=>{
    assert.match(error.message,/일치/);
    assert.equal(error.message.includes(password),false);
    return true;
  });
  assert.throws(()=>accountUi.validateNewPassword(password,''),/일치/);
});
test('customer cancellation cutoff is strict and uses Seoul time',()=>{
  const booking={status:'confirmed',date:'2026-10-31',start_time:'09:00'};
  assert.equal(canCustomerChange(booking,0,new Date('2026-10-30T23:59:59Z')),true);
  assert.equal(canCustomerChange(booking,0,new Date('2026-10-31T00:00:00Z')),false);
  assert.equal(canCustomerChange(booking,30,new Date('2026-10-30T23:30:00Z')),false);
  assert.equal(canCustomerChange({...booking,status:'cancelled'},0,new Date('2026-10-30T12:00:00Z')),false);
});
test('SQLite audit and invite timestamps are parsed as UTC in any browser timezone',()=>{
  assert.equal(parseTimestamp('2026-10-30 15:00:00').toISOString(),'2026-10-30T15:00:00.000Z');
  assert.equal(parseTimestamp('2026-10-30T15:00:00Z').toISOString(),'2026-10-30T15:00:00.000Z');
});
test('request IDs use secure RFC4122 v4 fallback when randomUUID is unavailable',()=>{
  let calls=0;
  const id=createRequestId({getRandomValues(bytes){calls++;assert.equal(bytes.length,16);bytes.fill(255);return bytes;}});
  assert.equal(calls,1);
  assert.equal(id,'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const native='6e38513b-10cd-4015-8dd4-df1c02cbe603';
  assert.equal(createRequestId({randomUUID:()=>native}),native);
});
