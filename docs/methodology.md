# Methodology Composition Policy

CraftHelm은 방법론을 단일 문자열이 아니라 4개 축으로 조합한다.

| 축 | 허용 값 | 역할 |
|---|---|---|
| `lifecycle` | `iterative`, `incremental`, `waterfall` | 단계 진행과 승인 게이트 |
| `specification` | `sdd`, `lightweight`, `existing` | 명세 상세도 및 ID 추적 |
| `engineering` | `tdd`, `test_after`, `characterization_first` | 테스트 선후 및 보존 전략 |
| `execution` | `full`, `stage` | 자동 진행 범위 |

## 표준 12단계 사전

`discover → interview → requirements → architecture → detailed_design → tasks → implementation → integration → technical_verification → review_package → human_acceptance → handoff`

- **Docs / Research 작업:** 코드 변경이 없으므로 RED-First를 강제하지 않고 출처·링크·형식·스키마 검증 계약을 적용한다.
- **Refactor (`characterization_first`):** 수정 전 기준선 GREEN 및 특성화 테스트를 먼저 확보한다.
- **Waterfall:** 요구사항·아키텍처·상세설계·통합·인수 단계에 별도 `approval_requirement` 게이트를 부착한다.
