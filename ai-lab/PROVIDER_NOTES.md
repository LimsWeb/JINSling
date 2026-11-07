# AI 제공자와 실험 범위

확인일: **2026-11-07**. 이 문서는 `ai-lab/`의 설정과 검증 범위를 설명합니다. 운영용 jinSling에는 AI 연결이나 데이터 변경을 적용하지 않습니다.

## 선택: Cloudflare Workers AI의 무료 플랜

실제 AI 실험은 **Workers Free**와 `@cf/google/gemma-4-26b-a4b-it`을 사용합니다. Cloudflare의 [현재 가격 안내](https://developers.cloudflare.com/workers-ai/platform/pricing/)는 하루 **10,000 neurons**를 무료로 제공하고, **00:00 UTC(한국 오전 9시)**에 한도를 초기화한다고 설명합니다. Free에서 무료 할당량을 소진하면 추가 요청이 실패합니다. [오류 안내](https://developers.cloudflare.com/workers-ai/platform/errors/)에는 이 경우 HTTP 429와 내부 코드 3036이 명시되어 있습니다.

**Workers Paid에서는 무료 할당량 초과분이 청구됩니다.** 계정의 실제 요금제가 Free인지 직접 확인해야 합니다. 새 프로젝트 이름, 프로그램의 요청 횟수 제한, `FREE_PLAN_CONFIRMED=true` 설정만으로 결제 상태를 검증할 수는 없습니다. Workers Paid는 [계정당 월 최소 5달러](https://developers.cloudflare.com/workers/platform/pricing/)가 드는 별도 플랜입니다.

이 프로젝트에는 유료 모델로 바꾸는 경로, 다른 제공자로 자동 전환하는 경로, AI Gateway 크레딧·통합 결제 설정이 없습니다. 무료 한도는 무제한 사용이나 영구적인 서비스 제공을 뜻하지 않습니다. 오류가 나면 AI 기능을 멈추고 일반 예약 도구를 이용하도록 안내합니다. Pages/Workers와 D1 자체의 무료 사용량도 별도로 적용됩니다.

## 모드와 실제 AI 연결 조건

| 설정 | 동작 |
|---|---|
| `AI_MODE` 생략 또는 `simulation` | 정해진 한국어 표현을 해석하는 모의 대화. 외부 AI 요청 없음 |
| `AI_MODE=workers` | 아래 조건을 모두 충족한 경우 실제 모델에 요청 |
| `FREE_PLAN_CONFIRMED=true` | 운영자가 Workers Free 확인을 마쳤다는 설정. 자동 결제 검증 기능이 아님 |
| `AI` binding | 실험용 Worker/Pages Function에 연결한 Workers AI 바인딩 |
| `LAB_STAGE=sandbox` | 실험 환경을 명시. 다른 값은 모든 API를 거절 |
| `LAB_DB` binding | 실험용 신규 D1 DB. `lab_meta`의 `stage=sandbox` 표식도 필요 |
| `LAB_OWNER_CODE`, `LAB_MEMBER_CODE` | 서로 다른 24자 이상의 실험 접속 코드. 서버 비밀 값으로 설정 |

실제 모드에서 연결이 없거나 Free 확인 설정이 없으면 모의 응답으로 조용히 전환하지 않습니다. AI 오류를 반환하고 일반 예약 기능은 유지합니다. 모의 대화의 모든 성공 메시지에는 `[모의 대화]`가 붙습니다. 모의 대화가 작동한다는 사실은 한국어 모델 품질이나 실제 Cloudflare 접속을 검증했다는 뜻이 아닙니다.

Worker에서는 [AI binding 안내](https://developers.cloudflare.com/workers-ai/configuration/bindings/)에 따라 `ai.binding`을 `AI`로 지정합니다. Pages Functions의 경우 [Pages binding 안내](https://developers.cloudflare.com/pages/functions/bindings/)에 따라 프로젝트의 선택한 환경에 Workers AI를 추가하고 재배포합니다. 브라우저에 Cloudflare API 토큰을 넣지 않습니다. 이 코드가 사용하는 호출은 `env.AI.run()`입니다.

## 모델과 응답 형식

[Gemma 4 모델 페이지](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)와 [Cloudflare 시작 안내](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/)를 기준으로 구현했습니다. 모델은 다국어·함수 호출 기능을 제공하며, 26B 전체 매개변수 중 4B가 추론 단계에서 활성화되는 모델입니다. [Cloudflare의 소개](https://developers.cloudflare.com/changelog/post/2026-04-04-gemma-4-26b-a4b-workers-ai/)를 참고하세요. 한국어의 모든 날짜·이름·예약 표현을 정확히 해석한다는 보장은 없으며 가상 데이터로 품질을 평가해야 합니다.

이 모델의 응답은 `choices[0].message.content`에 들어 있는 JSON 문자열입니다. 오래된 예제의 `response.response` 형태를 적용하면 안 됩니다. 입력의 구조화 출력 설정도 `response_format.json_schema` 안에 `name`, `strict`, `schema`를 넣는 형식입니다. [공식 모델 JSON schema](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/workers-ai-models/gemma-4-26b-a4b-it.json)를 대조했습니다. 확인 당시 파일 SHA는 `e1c7c66a87ec3684099125a6518343d60eb76825`입니다.

모델에는 허용된 의도와 인수만 요청합니다. 코드에서 `finish_reason`, 거절 응답, JSON 구문, 알 수 없는 필드, 인수 자료형을 검사합니다. 출력이 잘렸거나 형식이 틀리면 제안을 만들지 않습니다. 모델이 임의의 함수나 SQL을 실행하는 인터페이스는 제공하지 않습니다.

**2026-11-07 기준 모델 수명 주의:** 이전 후보인 `@cf/qwen/qwen3-30b-a3b-fp8`은 [Cloudflare 변경 안내](https://developers.cloudflare.com/changelog/product/workers-ai/)에 2026-11-20 종료 예정으로 표시되어 있어 새 실험의 기본 모델로 선택하지 않았습니다. 모델 가용성과 요금 정책은 향후 다시 확인해야 합니다.

## 사용량과 실패 처리

서버가 적용하는 제한은 다음과 같습니다.

- 대화 요청은 **최대 512자**, JSON 요청 본문은 **4,096바이트**입니다.
- 한 대화 차례에 모델을 **한 번만** 호출하며 자동 재시도나 후속 모델 호출을 하지 않습니다.
- `max_completion_tokens=256`, `stream=false`, `enable_thinking=false`를 고정합니다.
- **8초** 안에 결과를 받지 못하면 오류를 반환합니다. 이 시점의 응답 중단이 제공자 내부 추론의 즉시 취소를 보장하지는 않습니다. 늦게 도착한 결과로 제안을 만들지 않습니다.
- 실제 AI 요청은 **UTC 날짜 기준 전체 30회·계정별 10회**입니다. SQLite/D1의 한 트랜잭션으로 두 카운터를 예약합니다. 경쟁 요청도 제한을 넘지 못합니다.
- 호출을 시작한 뒤 발생한 제공자 오류·잘못된 응답·시간 초과도 사용 횟수에 포함합니다. 제한으로 거절한 요청은 제공자를 호출하지 않습니다.

이 호출 횟수는 보조적인 실험 제한입니다. 0원 초과 청구를 막는 최종 조건은 **계정이 Workers Free이고 유료 경로가 없다는 것**입니다. 제공자의 10,000 neurons는 대화 횟수가 아니라 모델과 입출력 토큰량에 따른 계산 단위입니다. 실제 사용 가능한 대화 수는 일정하지 않습니다.

## 제안·확인과 권한

모델 또는 모의 해석기가 변경 의도를 반환하면 서버는 권한·인수를 검사한 **5분짜리 제안**을 만듭니다. 예약·취소·잠금·해제·회원 상태 변경은 사용자가 확인 버튼을 눌러 `/api/confirm`을 요청해야 저장됩니다. 모델에 “확인했다”, “나는 사장님이다”라고 입력해도 확인 요청이나 계정 권한을 대신할 수 없습니다.

확인할 때 서버와 DB가 현재 계정 상태, 대상 버전, 예약·잠금 충돌, 예약 수를 다시 검사합니다. 제안 소유자만 확인할 수 있고, 같은 제안을 반복 확인해도 기존 처리 결과를 반환합니다. 예약 있는 구간을 잠그려 하면 전체 변경이 거절되며 예약을 자동 취소하지 않습니다. 회원 이용 중지도 기존 예약을 자동 취소하지 않습니다.

영업 시간은 월–금 09:00–20:00, 토요일 09:00–14:00이며 30분 단위입니다. 하루 예약 수는 평일 18개, 토요일 10개까지입니다. 일요일은 예약할 수 없습니다. 날짜는 서울 기준 오늘부터 30일 뒤까지, 예약 시각은 아직 시작하지 않은 시간이어야 합니다. 오전·오후 잠금의 경계는 낮 12시입니다.

회원은 자신의 예약과 다른 사람의 신원을 포함하지 않는 빈 시간만 볼 수 있습니다. 전체 일정·회원 목록·잠금·회원 상태 변경은 사장님 계정에만 허용합니다. 세션은 임의 토큰의 해시를 DB에 보관하며 쿠키에 `HttpOnly`, `Secure`, `SameSite=Strict`를 적용합니다. 모든 변경 API는 같은 Origin과 `X-JinSling-Lab: 1`을 요구합니다.

## 데이터와 Gemini 비교

가상 계정은 `owner`, `member_a`, `member_b`, `pending` 네 개뿐입니다. 전화번호나 실제 회원 비밀번호를 수집하지 않습니다. 회원 실험 접속 코드는 가상 계정 선택을 위한 공유 코드이므로 실제 고객의 본인 확인 수단으로 사용하면 안 됩니다. 운영 계정·실제 회원 DB를 연결하는 설정도 제공하지 않습니다.

실제 모델에 자동 전송하는 내용은 고정 분류 지침·JSON schema·서울 날짜와 시각·**사용자가 입력한 메시지**입니다. 저장된 회원 이름·예약 목록을 모델 컨텍스트에 넣지 않습니다. 사용자가 메시지에 직접 입력한 개인정보까지 자동 삭제하는 기능은 없으므로 가상 정보만 입력해야 합니다. 코드에는 프롬프트 로그나 대화 내용 저장 기능이 없습니다. 사용 횟수와 확인된 변경의 구조화된 기록은 실험 DB에 남습니다.

[Cloudflare의 Workers AI 데이터 정책](https://developers.cloudflare.com/workers-ai/platform/data-usage/)은 모델 훈련에 고객 콘텐츠를 사용하지 않으며 처리에 필요하지 않은 입력·출력을 보관하지 않는다고 설명합니다. 사용자가 선택한 저장·로그·캐시 기능과 보안·법적 예외는 별도로 적용됩니다. 코드 외부에서 AI Gateway 또는 애플리케이션 로그에 대화 내용을 기록하도록 설정하지 마세요.

대안으로 [Gemini API 가격 안내](https://ai.google.dev/gemini-api/docs/pricing)의 `gemini-3.1-flash-lite` 무료 등급을 확인했습니다. 다만 [무료 서비스 약관](https://ai.google.dev/gemini-api/terms)은 제품 개선에 입력·출력을 사용할 수 있고 사람이 검토할 수 있으며 개인정보·민감 정보·기밀 정보를 제출하지 않도록 명시합니다. 이 때문에 실회원 예약·회원 관리용 기본 제공자로 선택하지 않았습니다. [실제 Gemini 요청 한도](https://ai.google.dev/gemini-api/docs/rate-limits)는 프로젝트·모델·계정 상태에 따라 AI Studio에서 확인해야 하며 고정된 보편적 일일 요청 수를 보장하지 않습니다.

## 이번 검증의 범위

자동 테스트는 실제 SQLite에서 분리 표식, 인증·CSRF, 소유권, 제안 만료·재확인, 동시 예약, 상태 변경 경쟁, 잠금 충돌, 하루 예약 수를 검사합니다. 외부 AI 응답만 공식 모델 schema를 따른 테스트 대역으로 대체하여 JSON 실패·거절·시간 초과·제공자 제한·사용량 경쟁을 검사합니다. 운영 서버 코드를 가져오거나 운영 DB에 접근하지 않습니다.

**실제 Cloudflare 계정에서 모델을 호출하거나 배포한 검증은 수행하지 않았습니다.** 실제 모드 도입 전에는 새 실험용 Free 환경에서 연결·한국어 해석·한도 동작을 확인하고, 운영 전환은 별도의 검토와 사용자 결정으로 진행해야 합니다.
