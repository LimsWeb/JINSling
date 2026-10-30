# Web application

- `public/`: 한국어 브라우저 화면, 외부 의존성 없음.
- `server/`: Cloudflare 호환 API. 예약·회원·권한은 `env.DB`, 비밀번호 검증은 Firebase Authentication.
- `functions/api/[[path]].js`: Cloudflare Pages Functions 진입점.
- `migrations/`: 순서대로 적용하는 D1 스키마와 예약 충돌 검사. 기존 `0001`은 변경하지 않고 계정 전환용 `0002`를 추가.
- `dev/password-auth.mjs`: Node 전용 가상 계정 인증기. 운영으로 가져오지 않음.
- `tests/`: 실제 SQLite를 이용하는 테스트와 개발 어댑터.
- `scripts/dev.mjs`: 가상 데이터 개발 미리보기. 운영 배포 대상이 아님.
- `scripts/build.mjs`: `public/`을 `dist/`로 복사하고 정적 보안 헤더/라우팅 설정을 생성.

Cloudflare Git 배포 설정: 프로젝트 루트 `web`, 빌드 명령 `node scripts/build.mjs`, 출력 폴더 `dist`, D1 binding `DB`. `functions/`는 출력 폴더와 별도로 Pages가 컴파일합니다. 디렉터리 업로드만으로 서버 기능이 생긴다고 가정하지 마세요.

자세한 절차는 [무료 배포 안내](../docs/DEPLOY_FREE.md)를 따릅니다.

운영 인증 설정: `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`. `BOOTSTRAP_TOKEN`은 최초 관리자 등록 때만 사용합니다. 설정이 없으면 인증 준비 오류를 표시하며 로컬 인증기로 자동 대체하지 않습니다. 비밀값은 사장님 계정의 암호화된 설정에만 등록합니다.

`AUTH`는 테스트·개발 코드가 직접 주입하는 서버 객체입니다. 브라우저 입력이나 문자열 환경변수로 인증기를 바꿀 수 없습니다. Google 응답의 UID만 신뢰하며 브라우저가 전달하는 Firebase 토큰으로 권한을 부여하지 않습니다.

## 개발 미리보기

`scripts/dev.mjs`는 `.local/`의 가상 계정과 SQLite를 사용하는 개발 도구입니다. 실제 운영 서버로 사용하지 않습니다. 관리형 미리보기가 HTTP 주소를 제공하면 이 개발 어댑터에서만 임시 쿠키 이름을 사용합니다. 운영 API의 `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` 쿠키는 유지되며 실제 배포는 HTTPS 주소에서 확인해야 합니다.

프록시의 원본 주소가 다른 경우 `.local/preview-origin` 파일에 미리보기 도구가 반환한 정확한 origin을 기록합니다. 개발 미리보기 계정과 파일은 배포 및 Git에 포함하지 않습니다.
