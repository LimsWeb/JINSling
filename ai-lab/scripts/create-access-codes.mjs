import {randomBytes} from 'node:crypto';
console.log('LAB_OWNER_CODE='+randomBytes(32).toString('base64url'));
console.log('LAB_MEMBER_CODE='+randomBytes(32).toString('base64url'));
console.log('\nSave these as two secrets in the separate AI lab project. Do not commit them.');
