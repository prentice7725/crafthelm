# Methodology Composition Policy

CraftHelm은 방법론을 단일 문자열 하나로 고르지 않고 `lifecycle`, `specification`, `engineering`, `execution` 네 설정을 조합해 결정한다.

| 설정 | 허용 값 | 정하는 범위 |
|---|---|---|
| `lifecycle` | `iterative`, `incremental`, `waterfall` | 단계 구분과 승인 게이트 |
| `specification` | `sdd`, `lightweight`, `existing` | 명세 상세도와 ID 추적 여부 |
| `engineering` | `tdd`, `test_after`, `characterization_first` | 테스트 작성 순서와 회귀 보존 전략 |
| `execution` | `full`, `stage` | 자동 진행 범위 |

## 표준 12단계 사전

`discover → interview → requirements → architecture → detailed_design → tasks → implementation → integration → technical_verification → review_package → human_acceptance → handoff`

- `docs` 또는 `research` 작업에는 코드 변경이 없으므로 RED-First를 강제하지 않고 출처·링크·형식·스키마 검증 계약을 적용한다.
- `characterization_first`를 쓰는 리팩터링에서는 코드를 수정하기 전에 기준선 GREEN 상태와 특성화 테스트를 먼저 확보한다.
- `waterfall` 생명주기에서는 `requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance` 단계마다 별도 `approval_requirement` 게이트를 둔다.
