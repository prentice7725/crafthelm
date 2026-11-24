# Quality Contract & Verification Engineering

## 핵심 불변식

1. **Verification Is Executed Evidence:** 실제 프로그램을 실행한 stdout/stderr/exit code/trace로 판정한다.
2. **Protected Policy Baseline:** `REVIEW.md`, `.crafthelm/reliability-rules.json`, 보호 테스트 및 검증 설정은 승인된 `policy_base_ref`(`git show`) 또는 외부 보호 디렉터리에서 읽는다. 후보 브랜치가 수정한 검사 규칙을 평가 기준으로 쓰지 않는다.
3. **Snapshot Binding & Stale Detection:** 검증과 AI 리뷰는 특정 `target_snapshot_digest`에 결합된다. 이후 작업 트리가 바뀌면 기존 스탬프와 리뷰는 즉시 `STALE`이 된다.
4. **E2E Enforcement (`V01`):** 기능(`feature`) 또는 버그수정(`bugfix`) 변경에서 E2E smoke가 실패하거나 누락되면 단위 테스트가 모두 `PASS`여도 기술 승인을 차단한다. 유일한 예외는 13항의 경량 프로필 조건부 면제다.
5. **Property & Differential:** 불변식 위반 시 `seed`와 최소 `counterexample`을 보존하고(`V06`), 마이그레이션 비교 시 사전 승인된 `allowed_diffs` 외 차이는 `FAIL` 처리한다(`V07`).
6. **Diff-Triggered Reliability Rules:** 변경 경로/심볼이 매칭되는 규칙만 실행하고 비발동 사유를 기록한다. 신규 규칙은 `observe`로 도입하며, 승인 전까지 차단하지 않는다(`V05`).
7. **3-Round Repair Limit (`V04`):** 동일 원인 실패가 3라운드 지속되면 `BLOCKED_HUMAN_ATTENTION`으로 중단하고 최소 재현 명령·Diff·시도 이력·선택지를 사람에게 보고한다.
8. **No Flaky Silencing:** sleep 추가, 무한 재시도, 침묵 속 스킵을 금지한다.
9. **다언어 AST/콜 그래프 영향도 분석 및 안전한 회귀 테스트 선별 (`scripts/lib/impact-analysis.mjs`, `scripts/lib/impact-languages.mjs`, `scripts/lib/test-runners.mjs`, `verify --selective`):** Diff hunk와 다언어(JS/TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby, PHP) import·package·함수/클래스 콜 그래프 및 외부 커스텀 분석기(`custom_impact_analyzer`)를 결합해 직간접 영향 테스트만 선별하고 러너별 명령을 생성한다. 단, `e2e`/`always_run` 검사는 생략하지 않으며 전역 설정·스키마·미분석 소스 변경이나 매칭 0건 시 자동으로 전체 테스트(`fallback_to_full`)로 폴백한다.
10. **상한 있는 검증·피드백·승인 요청 루프 (`scripts/feedback-loop.mjs`):** 검증 실패 시 `evidence/feedback-packet.json`을 생성해 수정→재검증을 반복하고, 통과 시 Kouetsu 교열을 거친 Review Package(`READY_FOR_HUMAN_REVIEW`)를 발행해 사람에게 승인을 요청한다(`approvals/decision.json` 자동 생성 금지).
11. **증거 강도 등급 (`scripts/lib/evidence-strength.mjs`):** `PASS`는 명령이 기대한 종료 코드로 끝났다는 뜻일 뿐, 그 검사가 이번 변경을 다뤘다는 뜻은 아니다. `verify`는 수용 기준 실행 결과와 영향도 분석을 근거로 `evidence_strength`(`strong` / `moderate` / `weak` / `not_applicable`)를 증거 매니페스트에 기록하고, 검토 보고서 1절과 6절에 표시한다. 이 등급은 `technical_status`를 바꾸지 않으며 사람이 직접 확인할 항목을 알려 준다.

    | 신호 | 등급 | 조건 |
    |---|---|---|
    | `NO_EXECUTED_PASSING_CHECK` | weak | 실행되어 통과한 수용 기준이 없다 |
    | `NO_TEST_REACHES_CHANGE` | weak | 변경된 코드를 불러오거나 호출하는 테스트 파일이 없다 |
    | `SINGLE_GENERIC_CHECK` | weak | 실행된 검사가 `kind: "test"` 범용 명령 하나뿐이다 |
    | `NO_TEST_CHANGED` | moderate | `feature`/`bugfix`인데 추가·수정된 테스트가 없다 |
    | `IMPACT_INCONCLUSIVE` | moderate | 영향도 분석이 그래프를 만들지 못해 도달 여부를 알 수 없다 |

    | `MUTANTS_SURVIVED` | moderate (제거율 50% 미만이면 weak) | 뮤테이션 검사에서 살아남은 변이가 있다 |

    `docs`/`research` 변경과 소스 파일을 건드리지 않은 변경은 `not_applicable`이다. 도달 여부는 정적 import·호출 그래프 기준이므로 동적 로딩이나 리플렉션으로만 닿는 테스트는 잡지 못한다.
12. **뮤테이션 검사 (`scripts/lib/mutation-probe.mjs`, `verify --mutation-probe`):** 단일 공급자 환경에서는 다른 계열 모델의 교차 리뷰를 쓸 수 없으므로, 테스트가 변경을 실제로 붙잡는지를 결정적으로 확인한다. 변경된 줄을 한 번에 하나씩 깨뜨리고(비교·불리언·산술 연산자 뒤집기) 통과했던 검사를 다시 돌려 실패하는지 본다. 실패하지 않은 변이는 "그 줄이 틀려도 테스트가 모른다"는 구체적인 증거이며 `evidence/mutation-probe.json`에 파일·줄·연산자로 남는다.

    - 켜는 방법: `verify --mutation-probe [--max-mutants <n>]`, `feedback --mutation-probe`, 또는 계약의 `verification_policy.mutation_probe: true`. 기본값은 꺼짐이며, 변이 수만큼 검사를 반복하므로 시간이 든다(기본 상한 8개).
    - 인수 검사가 모두 통과하고 그때까지 실패 사유가 없을 때 실행한다. 실행 시점은 E2E·경량 프로필 판정 직전이며, 신뢰성 규칙과 독립 리뷰 확인은 그 뒤에 이뤄진다.
    - 결과는 증거 강도 신호 `MUTANTS_SURVIVED`로 반영한다. 전체 프로필에서는 `technical_status`를 바꾸지 않는다. 경량 프로필에서는 이 신호로 증거 강도가 `weak`가 되면 E2E 면제가 취소된다(13항).
    - 작업 트리 안전: 변이는 `finally`에서 원본 바이트로 복원하고 복원 후 해시를 대조한다. 실행 전 원본을 실행 디렉터리에 기록해 두어, 중간에 프로세스가 죽어도 다음 실행이 먼저 복구한다.
    - 한계: 파서 없이 토큰 단위로 치환한다. 문자열 안의 연산자를 바꾸거나 의미가 같은 변이(동치 변이)를 만들 수 있어 생존 변이는 사람이 확인할 후보이지 결함 확정이 아니다. 연산자가 없는 줄은 대상이 되지 않는다.
13. **경량 프로필의 E2E 조건부 면제 (`scripts/lib/lite-profile.mjs`, `process_profile: "lite"`):** 작은 버그 수정에 한해 V01의 E2E 요구를 면제한다. 면제는 선언만으로 주어지지 않고, `verify`가 실제 diff로 아래 조건을 매번 다시 확인한다.

    | 조건 | 기본값 | 계약에서 조정 |
    |---|---|---|
    | `change_kind` | `bugfix`만 허용 | 불가 |
    | 변경된 소스 파일 수 | 3개 이하 | `verification_policy.lite_max_changed_source_files` (1~10) |
    | 소스에 추가된 줄 수 | 60줄 이하 | `verification_policy.lite_max_added_lines` (1~300) |
    | 증거 강도 | `weak`가 아닐 것 | 불가 |

    - 조건을 모두 만족하고 E2E 검사가 계약에 없으면 면제한다. 면제된 E2E는 통과로 치지 않고 미검증 항목으로 남기므로 `technical_status`는 `PARTIAL`이 되고, 검토 보고서 1절과 6절에 면제 사실이 표시된다.
    - 조건을 하나라도 벗어나면 `LITE_PROFILE_EXCEEDED`로 실패한다. E2E 검사를 추가하거나 전체 프로필로 재계획해야 한다.
    - 증거 강도 조건 때문에 범용 테스트 명령 하나만 있는 계약(`SINGLE_GENERIC_CHECK`)이나 변경 코드에 닿는 테스트가 없는 변경(`NO_TEST_REACHES_CHANGE`)은 면제를 받지 못한다.
    - 한도는 승인된 계약에 들어 있어 실행 중에 바꾸면 계약 해시 불일치로 걸린다.
    - 뮤테이션 검사를 켰다면 증거 강도는 검사 결과를 반영한 등급으로 판정한다. 변이가 절반 넘게 살아남아 등급이 `weak`가 되면 면제를 받지 못하고 `LITE_PROFILE_EXCEEDED`(`MUTANTS_SURVIVED`)로 실패한다. 생존 변이가 절반 이하라 등급이 `moderate`이면 면제는 유지되고 보고서의 증거 강도 신호로 드러난다.
    - 한계: 뮤테이션 검사는 기본으로 꺼져 있다. 경량 계약이 검사를 켜지 않으면 증거 강도는 정적 도달 여부로만 판정된다.
