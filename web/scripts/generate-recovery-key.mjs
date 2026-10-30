import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'../.local');

// Offline only. Applying the generated SQL requires the Cloudflare account owner's
// normal database permissions; this helper adds no production recovery endpoint.
export function generateRecoveryKey({directory=defaultDirectory,userId=null}={}) {
  if(userId!==null&&(typeof userId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(userId)))throw new TypeError('Invalid recovery account ID');
  const keyPath=join(resolve(directory),'recovery-key.txt');
  const sqlPath=join(resolve(directory),'admin-recovery.sql');
  const loginKey=randomBytes(32).toString('base64url');
  const keyHash=createHash('sha256').update(loginKey).digest('hex');
  const where=userId===null?"role = 'admin' AND (SELECT count(*) FROM users WHERE role = 'admin') = 1":`id = '${userId}'`;
  const sql=`-- Apply once to the verified jinSling database using its owner's access.
-- REQUIRED: stop credential requests and confirm no provider mutation is still
-- in flight before clearing a failed operation's lock. Locks do not auto-expire.
-- Converted account: this secret is a 24-hour single-use reset token (#reset=...).
-- Legacy account: this secret is a restricted login key for password setup.
-- Existing triggers revoke sessions and append a secret-free audit.
UPDATE users
SET key_hash = CASE WHEN provider_uid IS NULL THEN '${keyHash}' ELSE key_hash END,
    password_reset_required = CASE WHEN provider_uid IS NULL THEN 0 ELSE 1 END,
    reset_token_hash = CASE WHEN provider_uid IS NULL THEN NULL ELSE '${keyHash}' END,
    reset_expires_at = CASE WHEN provider_uid IS NULL THEN NULL ELSE datetime('now','+24 hours') END,
    credential_lock = NULL, credential_lock_started_at = NULL,
    credential_revision = credential_revision + 1, updated_by = id
WHERE ${where};
SELECT changes() AS accounts_recovered;
`;
  mkdirSync(resolve(directory),{recursive:true,mode:0o700});
  const created=[];
  try {
    for(const [path,content] of [[keyPath,loginKey+'\n'],[sqlPath,sql]]) {
      const fd=openSync(path,'wx',0o600);created.push(path);
      try {writeFileSync(fd,content,'utf8');}finally{closeSync(fd);}
    }
  } catch(error) {
    // Remove only this invocation's files; an existing recovery file is never touched.
    for(const path of created)unlinkSync(path);
    throw error;
  }
  return {keyPath,tokenPath:keyPath,sqlPath};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const userId=process.argv.find(arg=>arg.startsWith('--user-id='))?.slice('--user-id='.length)??null;
    const {keyPath,sqlPath}=generateRecoveryKey({userId});
    console.log(`새 계정 복구 토큰 파일: ${keyPath}`);
    console.log(`관리자 복구 SQL 파일: ${sqlPath}`);
    console.log('docs/DEPLOY_FREE.md의 소유자 복구 절차에 따라 실행 중인 비밀번호 요청을 중지하고, DB 소유자가 대상을 확인한 후 SQL을 적용하세요.');
    console.log('토큰은 화면에 출력하지 않습니다. 전환 계정은 24시간 재설정 링크로, 기존 계정은 비밀번호 설정용 접속키로 사용하세요. 기존 파일은 덮어쓰지 않습니다.');
  } catch {
    console.error('복구 파일을 생성하지 못했습니다. 기존 복구 파일과 폴더 접근 권한을 확인하세요. 기존 파일은 덮어쓰지 않습니다.');
    process.exitCode=1;
  }
}
