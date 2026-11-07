# 반복 예약 잠금

## 목적
운영자가 점심시간 같은 반복 휴무를 한 번 등록하면 고객과 운영자의 예약 가능 시간에 계속 적용한다. 기존 하루·반나절·기간 잠금은 유지한다. 현재 운영 계정과 데이터, 무료 배포 구조를 사용하며 AI 실험 프로젝트는 변경하지 않는다.

## 사용자 동작
- 운영 설정의 반복 잠금에서 점심시간 월~토 13:00–14:00 빠른 설정을 제공한다. 저장 전 날짜와 예약 충돌을 미리 확인한다.
- 매일, 매주 선택 요일, 격주 선택 요일, 매달 특정 날짜, 매달 첫째~다섯째 또는 마지막 특정 요일을 지원한다.
- 격주는 시작일이 속한 월요일 시작 주가 첫 적용 주다. 시작일 전에는 적용하지 않는다.
- 매달 29~31일 또는 다섯째 요일이 없는 달은 건너뛴다. 종료일은 선택 사항이고 양끝 날짜를 포함한다.
- 하루 안에서 30분 단위 시작~종료를 지정하며 24:00 종료를 지원한다. 자정을 넘기는 잠금은 두 규칙으로 설정한다.
- 수정, 일시중지/재개, 전체 해제, 특정 날짜만 예외로 열기 및 예외 복원을 제공한다.
- 기존 확정 예약과 충돌하는 새 규칙·수정·재개·예외 복원은 거부한다. 예약은 자동 취소하지 않는다.

## 데이터와 안전성
반복 규칙을 저장하고 조회 날짜에 적용 여부를 계산한다. 반복 날짜 전체를 미리 생성하거나 예약된 서버 작업을 요구하지 않는다. D1에 별도 규칙·예외 테이블과 예약/규칙 충돌 방지 트리거를 추가한다. 서버와 SQL의 날짜 판정은 동일한 기준이며 실 SQLite 통합 검증을 한다.

기존 데이터베이스의 신규 테이블과 트리거는 최초 관리자 변경 요청 시 멱등적인 D1 batch로 추가한다. 기존 테이블은 삭제하거나 재작성하지 않는다. 신규 스키마가 전혀 없는 배포에서는 기존 동작을 유지하고, 부분 설치는 안전하게 차단한 뒤 관리자 요청으로 복구한다. 마이그레이션 SQL도 제공한다.

반복 규칙 최대 32개. 일반 회원에게는 예약 불가 시간만 전달하며 반복 메모·고객 정보는 전달하지 않는다. 모든 변경은 승인된 관리자, 기존 Origin/JSON 보호, 버전 확인을 거친다. 생성 요청 재시도는 request_id로 중복 방지한다.

## API 계약
기본 경로 `/api/admin/recurring-blocks`.

규칙 필드: `id`, `frequency` (`daily|weekly|biweekly|monthly`), `start_date`, `end_date` (null 허용), `weekdays` (0=일요일), `monthly_mode` (`day|weekday`), `month_day`, `month_week` (1..5 또는 -1), `month_weekday` (0..6), `start_time`, `end_time`, `note`, `enabled`, `version`, `exceptions` (날짜 문자열 배열).

- GET 기본 경로 → `{items, schema_ready}`; 삭제 규칙 제외.
- POST `/preview` → `{rule, occurrences:[{date,start_time,end_time}], conflicts:[{date,start_time,end_time}], conflict_count, can_save}`. 생성 필드, 수정 시 `id`, `version` 허용. 실제 일정 변경 없음.
- POST 기본 경로: 생성 필드 + `request_id` → `{rule}`.
- PUT `/:id`: 전체 설정 + `version` → `{rule}`.
- PATCH `/:id`: `enabled`, `version` → `{rule}`.
- DELETE `/:id`: `version` → `{}` (soft delete).
- PUT `/:id/exceptions/:date`: `version` → `{rule}` (그 날짜만 개방).
- DELETE `/:id/exceptions/:date`: `version` → `{rule}` (그 날짜 잠금 복원).

저장 시점에 충돌을 다시 확인하고 DB가 동시에 도착한 예약/잠금 충돌을 차단한다. 예외는 해당 규칙만 해제하며 다른 잠금과 휴무 요일은 유지한다.
