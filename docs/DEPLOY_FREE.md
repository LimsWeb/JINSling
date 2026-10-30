# 비용 0원으로 배포하기

확인 기준: 2026-10-30. 준비된 소스와 배포 절차이며, 실제 클라우드 계정 연결·배포 완료를 뜻하지 않습니다. [실제 검증 상태](VERIFICATION.md)를 함께 확인합니다.

## 구성과 소유자

| 역할 | 서비스 | 조건 |
|---|---|---|
| 웹 화면·API 실행 | Cloudflare Pages / Functions | Free, 제공되는 `pages.dev` 주소 |
| 회원·예약·승인 상태 | Cloudflare D1 | 사장님 계정, Free |
| 비밀번호 검증 | Firebase Authentication | 사장님 프로젝트, **Spark** |
| 운영 소스와 배포 제어 | 사장님 소유 GitHub 저장소 | 개발자 쓰기 권한 없음 |

운영 중 켜 놓을 PC나 로컬 서버는 없습니다. 개인 PC는 최초 설정·개발·필요시 복구 명령에만 사용할 수 있습니다. 유료 도메인·SMS·알림톡·AI·유료 플랜·결제수단은 이 구성에 필요하지 않습니다. Firebase에 결제 계정을 연결하면 Blaze로 전환되므로 연결하지 않습니다. [Firebase 요금제](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)

사장님이 계정을 직접 소유합니다. 개발자에게 실제 DB나 배포 권한을 주지 않는 방법은 [개인정보와 권한 분리](OWNER_DATA.md)를 따릅니다. 개발 저장소에서 운영으로 자동 배포하면 개발자도 데이터를 읽는 코드를 배포할 수 있으므로, 운영 저장소 반영은 사장님이 통제합니다.

## 1. 운영 소스 준비

사장님 소유 저장소에 확인한 버전의 코드를 반영합니다. 운영 브랜치를 Pages와 연결하고, 개발자에게 운영 저장소 쓰기 권한·배포 훅·Cloudflare 토큰을 주지 않습니다. 개발 브랜치 미리보기에는 운영 DB나 비밀값을 연결하지 않습니다.

Node.js 24 이상에서 아래 명령으로 확인합니다.

```sh
npm test
npm run check
npm run build
```

기존 Python 파일은 보존되어 있으며 새 앱의 루트는 `web`입니다. `npm run dev`는 가상 데이터 개발 미리보기로, 실제 매장 운영 서버가 아닙니다.

## 2. Firebase Spark 인증 준비

사장님 Google 계정에서 Firebase 프로젝트를 만들고 **Spark** 상태를 확인합니다. Google Analytics, Cloud Functions, Cloud Storage, Phone Authentication, 유료 Identity Platform 업그레이드는 이번 구성에 필요하지 않습니다.

Authentication의 로그인 방식에서 **Email/Password**만 켭니다. 이메일 링크 로그인은 사용하지 않습니다. 사용자는 앱에 아이디와 비밀번호를 입력하고, 서버가 아이디를 `아이디@jinsling-auth.invalid` 형태의 배달되지 않는 별칭으로 변환합니다. 실제 이메일을 수집하거나 인증·복구 메일을 발송하지 않습니다.

이는 앱의 아이디 변환 방식이며 Firebase가 기본 아이디 로그인을 지원한다는 뜻은 아닙니다. **실제 프로젝트에서 `.invalid` 별칭 가입·로그인이 허용되는지 반드시 확인합니다.** 로컬 테스트는 이 정책을 증명하지 않습니다. 허용되지 않으면 비용·개인정보 조건을 유지하는 인증 구성을 다시 결정한 뒤 출시합니다. 임의의 실존 이메일 주소로 대체하지 않습니다.

Firebase 프로젝트의 Project ID와 Web API Key를 확인합니다. 같은 Google Cloud 프로젝트에서 앱 전용 서비스 계정을 만들고 **Firebase Authentication Admin (`roles/firebaseauth.admin`)** 권한을 부여합니다. 프로젝트 전체 Owner/Editor를 부여할 필요는 없습니다. 이 계정은 서버에서 회원 비밀번호 변경·잘못 완료된 가입 정리에 사용합니다. 키 생성이 계정 정책으로 금지되어 있으면 정책을 우회하지 말고 소유자가 허용 가능한 인증 방식을 정해야 합니다.

사장님이 서비스 계정의 JSON 키를 자신의 비공개 장소에 보관합니다. GitHub·대화·공개 파일·개발 미리보기에 넣지 않습니다. Cloudflare 서버 비밀값으로만 등록합니다. API Key도 브라우저 코드에 넣지 않지만, API Key만으로 관리자 권한이 생기는 구조는 아닙니다.

공식 자료: [비밀번호 인증](https://firebase.google.com/docs/auth/web/password-auth), [인증 REST API](https://firebase.google.com/docs/reference/rest/auth), [Firebase IAM 역할](https://firebase.google.com/docs/projects/iam/roles-predefined-product#authentication), [서비스 계정 OAuth](https://developers.google.com/identity/protocols/oauth2/service-account).

## 3. D1 생성과 마이그레이션

Cloudflare Free 계정의 D1 영역에서 새 DB를 만듭니다. 아래 예시 이름은 `jinsling-db`이며 실제 이름이 다르면 명령도 바꿉니다. 실제 Database ID를 확인합니다.

```sh
cd web
node scripts/configure-cloudflare.mjs
```

Cloudflare가 발급한 실제 ID와 이름을 입력합니다. 스크립트는 로컬 `wrangler.jsonc`만 생성하며 이 파일은 기본 Git 제외 대상입니다. Git 배포에서는 대시보드 binding 설정을 사용합니다.

```sh
npx wrangler@4 login
npx wrangler@4 d1 migrations apply jinsling-db --remote --config wrangler.jsonc
```

명령이 가리키는 계정·DB를 확인한 뒤 실행합니다. 신규 DB에는 `0001_initial.sql`, `0002_accounts.sql`이 순서대로 적용됩니다. 기존 0001 운영 DB는 먼저 백업한 뒤 0002를 적용합니다. 0001 파일을 다시 고치거나 기존 DB를 삭제해 업그레이드하지 않습니다. 0002는 기존 회원·예약 ID를 보존하고 기존 접속키 계정이 비밀번호 방식으로 전환할 수 있게 합니다.

공식 안내: [D1 마이그레이션](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply).

## 4. Pages 연결과 서버 설정

사장님 운영 GitHub 저장소의 운영 브랜치를 Pages에 연결합니다.

| 설정 | 값 |
|---|---|
| Framework preset | None |
| Root directory | `web` |
| Build command | `node scripts/build.mjs` |
| Build output directory | `dist` |
| Node version | `24` |
| D1 binding | 이름 `DB`, 실제 운영 D1 선택 |

Production 환경에 다음 값을 등록합니다. 서비스 계정 JSON과 설정 토큰은 반드시 암호화된 secret으로 보관합니다. 나머지 Firebase 설정도 동일한 서버 설정에 두며 공개 빌드 파일로 복사하지 않습니다.

| 이름 | 값 |
|---|---|
| `FIREBASE_PROJECT_ID` | 사장님의 실제 Firebase Project ID |
| `FIREBASE_API_KEY` | 같은 프로젝트의 Web API Key |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | 같은 프로젝트 전용 서비스 계정 JSON 전체 |
| `BOOTSTRAP_TOKEN` | 아래 단계에서 생성하는 최초 등록 토큰 |

binding과 비밀값 등록 후 다시 배포합니다. 코드의 `auth_ready`는 설정 모양만 확인하며 서비스의 실제 연결·권한·호스팅 한도를 보장하지 않습니다. 설정이 없으면 인증 준비 오류가 나오고 개발 인증기로 대체하지 않습니다.

`web/functions/`는 정적 `dist`와 별도로 Pages가 컴파일합니다. 파일 업로드만으로 API가 생겼다고 가정하지 않습니다. `wrangler.jsonc`를 의도적으로 운영 저장소에 포함한다면 대시보드 설정과의 우선순위를 공식 문서로 확인합니다.

공식 안내: [Pages Git 연결](https://developers.cloudflare.com/pages/get-started/git-integration/), [D1 binding](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases), [환경 비밀값](https://developers.cloudflare.com/pages/functions/bindings/#secrets), [Wrangler 설정](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).

## 5. 최초 관리자 등록

사장님 PC의 `web` 폴더에서 실행합니다.

```sh
node scripts/generate-setup-token.mjs
```

`web/.local/setup-token.txt`의 내용을 Cloudflare의 암호화된 `BOOTSTRAP_TOKEN`으로 등록합니다. `.local`은 Git·배포에 포함하지 않습니다. 기존 파일은 덮어쓰지 않습니다.

실제 발급된 HTTPS `pages.dev` 주소를 열고 설정 토큰, 사장님 이름·개인 전화번호, 관리자 아이디·비밀번호를 입력합니다. 아이디 4–32자, 비밀번호 15–128자이며 문자·이메일 인증은 없습니다. 기본 관리자 비밀번호도 없습니다. 최초 등록 후 `BOOTSTRAP_TOKEN`을 제거하고 다시 배포합니다.

개인 전화번호는 공개 매장 연락처에 자동 복사하지 않습니다. 공개할 번호는 설정에서 별도로 입력합니다. 기존 키 계정이 있다면 예전 키로 로그인해 같은 계정에 아이디·비밀번호를 설정합니다. 전환 후 예전 키는 사용할 수 없습니다.

## 6. 실제 연결 확인 후 4–5명 시험

가상 정보로 먼저 Firebase 가입·로그인·로그아웃·새 기기 재로그인, 사장님 승인, 비밀번호 변경·초기화를 확인합니다. 서비스 계정 권한과 OAuth 서명에 필요한 Cloudflare Free CPU도 이때 확인합니다. 무료 CPU 제한에 맞지 않으면 운영을 시작하지 않고 무료 대안을 다시 판단합니다. 유료 플랜으로 자동 전환하지 않습니다.

그 뒤 사장님과 사용자 포함 4–5명으로 실제 시험을 시작합니다. 가입은 기본 공개 신청 방식입니다. 사장님이 처음 한 번 승인한 뒤에는 밤에도 독립적으로 로그인합니다. 첫 가입 미승인자는 계속 대기합니다. 등록 한도는 기본 100명, 설정상 최대 1,000명이며 시험 인원과 별개입니다.

사장님 휴대폰에서 회원 선택 전화 예약, 오늘 일정, 시간 차단, 이동·취소를 해봅니다. 고객 둘이 같은 시간을 선택하면 하나만 확정되는지 확인합니다. 무료 요청·DB 사용량과 실패 안내까지 확인한 뒤 실제 업무에 사용합니다.

## 무료 한도와 비용 경계

Pages Functions는 Workers Free의 하루 100,000회 요청 한도를 공유합니다. Functions를 거치지 않는 정적 자산 요청은 무료입니다. Free의 CPU 제한은 요청당 10ms이며 외부 네트워크를 기다리는 시간과 실제 CPU 사용량은 다릅니다. 실제 인증·OAuth 서명 비용은 배포 후 측정해야 합니다.

D1 Free는 하루 500만 행 읽기·10만 행 쓰기, 계정 합계 5GB, 단일 DB 500MB가 현재 기준입니다. 무료 한도를 넘으면 쿼리가 제한됩니다. 앱은 유료 업그레이드를 실행하지 않습니다. [Pages 가격](https://developers.cloudflare.com/pages/functions/pricing/) · [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/) · [D1 가격](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 한도](https://developers.cloudflare.com/d1/platform/limits/)

Firebase Spark는 결제정보 없이 시작할 수 있으며 비밀번호 인증은 무료 범위에 들어갑니다. 등록 사용자 수, 활성 사용자 수, 요청 속도 제한은 다릅니다. 문서의 3,000 DAU는 **Identity Platform을 사용하는 Spark**의 Tier 1 조건입니다. 모든 Firebase 설정에 같은 숫자가 적용된다고 설명하지 않습니다. 가입 생성에는 IP별 시간당 제한도 있습니다. 앱 1,000명 상한은 무료 서비스의 최대 수용 인원이나 부하 검증 결과가 아닙니다. [Firebase 한도](https://firebase.google.com/docs/auth/limits)

무료 정책이 바뀌면 사장님이 백업을 확보하고 유지·중지·이전을 결정합니다. 비용 0원 조건에서는 한도 초과나 제공 중단 때 서비스가 제한되는 선택을 받아들여야 합니다. 영구 무료와 무중단을 함께 보장하지 않습니다.

## 백업

사장님 화면의 회원 CSV·예약 CSV는 업무 확인용입니다. 비밀번호 원문·해시·초기화 토큰은 CSV에 들어가지 않으며, CSV만으로 계정·권한·변경 기록을 복원할 수는 없습니다.

전체 D1 백업은 사장님 계정으로 실행합니다.

```sh
npx wrangler@4 d1 export jinsling-db --remote --config wrangler.jsonc --output ../jinsling-backup.sql
```

실제 고객 정보가 있으므로 비공개 위치에 보관하고 Git에 올리지 않습니다. 업데이트 전에도 백업합니다. D1 Free Time Travel은 최근 7일 복원 범위이며 장기 백업을 대신하지 않습니다. 시점 복원은 이후 정상 예약도 되돌릴 수 있으므로 현재 DB를 먼저 보관합니다. [내보내기](https://developers.cloudflare.com/d1/wrangler-commands/#d1-export) · [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

D1 백업에 Firebase 비밀번호 검증 정보는 들어 있지 않습니다. 두 서비스가 한 트랜잭션으로 복원되지는 않습니다. 복원 후 연결 UID·회원 상태·로그인을 확인하고 필요한 계정은 초기화합니다. Firebase 프로젝트를 삭제하고 D1 백업만으로 동일한 로그인을 되살릴 수 있다고 보지 않습니다.

## 계정 분실과 중단된 비밀번호 처리 복구

일반 회원은 사장님이 본인을 확인한 뒤 회원 관리의 초기화 링크를 전달합니다. 링크는 24시간·일회용이며 발급 즉시 기존 로그인이 종료됩니다. 원문 비밀번호를 알려 주거나 모든 회원에게 공통 임시 비밀번호를 주지 않습니다.

관리자 비밀번호를 잃었거나 비밀번호 변경 중 서비스 오류로 계정 잠금이 남으면 **사장님 소유 Cloudflare 접근권한**으로 복구합니다. Firebase 변경과 D1 저장은 한 트랜잭션이 아니므로 결과가 불확실할 때는 로그인과 다음 변경을 막는 편을 택합니다. 잠금은 시간이 지났다고 자동으로 풀리지 않습니다.

복구 전에 새 자격증명 변경 요청을 잠시 차단하고, 기존 Firebase 변경 요청이 더 이상 실행 중이지 않은지 확인합니다. 예를 들어 운영 인증 설정을 임시로 비활성화해 새 인증 호출을 막은 뒤, 이전 배포의 요청과 제공자 작업 상태를 확인합니다. **임의의 몇 초가 지났다는 이유만으로 안전하다고 판단하지 않습니다.** 확인되지 않으면 잠금을 풀지 않습니다. 이 작업은 운영 계정 소유자의 복구 절차이며 개발자에게 고객 DB를 넘겨야 하는 방식이 아닙니다.

현재 DB를 먼저 백업한 뒤 사장님 PC의 `web`에서 실행합니다.

```sh
node scripts/generate-recovery-key.mjs
```

기본 대상은 DB의 유일한 관리자입니다. 특정 회원 복구가 필요하면 사장님이 확인한 회원 ID로 `--user-id=실제회원ID` 옵션을 사용합니다. 새 256비트 비밀값과 SQL은 `.local/recovery-key.txt`, `.local/admin-recovery.sql`에 생성됩니다. 파일 권한은 0600이고 기존 파일은 덮어쓰지 않습니다. Windows에서는 본인만 읽을 수 있는지도 확인합니다. 토큰은 터미널에 출력하지 않습니다.

대상 계정·DB를 확인하고, 새 요청이 차단되어 있고 이전 변경이 더 이상 실행 중이지 않음을 확인한 뒤 다음 명령을 실행합니다. 여기부터 원격 운영 DB를 변경합니다.

```sh
npx wrangler@4 login
npx wrangler@4 d1 execute jinsling-db --remote --config wrangler.jsonc --file .local/admin-recovery.sql
```

`accounts_recovered`가 정확히 1인지 확인합니다. SQL은 기존 회원의 권한·예약을 유지하고 세션을 폐기합니다. 0이면 DB와 회원 ID를 확인하며 새 관리자 계정을 임의로 만들지 않습니다.

인증 설정을 복구한 뒤, 비밀번호 전환을 마친 계정은 실제 운영 주소 뒤에 `#reset=`와 비밀값을 붙인 링크를 본인 브라우저에서 열어 새 비밀번호를 정합니다. 이 토큰은 SQL 적용 후 24시간 동안 한 번 작동합니다. 기존 키 계정은 생성 비밀값으로 '기존 접속키 계정 전환'을 진행합니다. 링크·비밀값을 대화나 Git에 올리지 않습니다. 복구와 예약 보존 확인 후 복구 파일을 안전하게 정리해 같은 SQL을 재실행하지 않습니다.

가입 또는 기존 계정 전환 중 Google 응답·DB 응답이 끊기면 연결되지 않은 Firebase 사용자만 남을 수도 있습니다. 앱은 그런 사용자에게 권한을 부여하지 않습니다. 같은 아이디가 사용 중이라고 나올 때는 사장님이 Firebase의 해당 별칭과 D1의 `username`·`provider_uid` 연결을 대조합니다. **어떤 D1 회원에도 연결되지 않은 제공자 계정임이 확인된 경우에만** 그 Firebase 계정을 정리하고 다시 신청합니다. 결과를 확인하지 않은 채 이름이 비슷한 사용자나 프로젝트 전체를 삭제하지 않습니다.

공식 명령: [D1 SQL 실행](https://developers.cloudflare.com/d1/wrangler-commands/#d1-execute).

## 인수인계

운영 주소, 관리자 아이디 보관 방법, Cloudflare·Firebase 계정 복구 수단, 운영 저장소, 사용 안내, 백업 위치를 사장님에게 전달합니다. 실제 개인정보·비밀값을 개발자가 가진 소스에 넣지 않습니다. 고객에게 안내할 수집 목적·보관 기간·삭제 요청 방법은 실제 매장 운영에 맞춰 확정하는 배포 전 항목입니다.
