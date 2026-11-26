# Delegation Policy — Lead Token Firewall

## 역할과 비용 경계

- Lead는 아키텍처, 요구 충돌 해결, 고위험 의사결정, 최종 검토 패키지 구성 판단을 맡는다. 1~2개 파일만 고치는 단순 수정은 위임 오버헤드가 더 크면 Lead가 직접 처리한다.
- Explorer, Planner, Builder, Reviewer, Learning Curator는 호스트 네이티브 Subagent 또는 독립 컨텍스트 세션에서 실행한다.
- Verifier 역할은 모델 호출 없이 결정적 스크립트(`scripts/verify.mjs`)로 실행한다.

## 단일 모델 환경 규칙

단일 모델만 사용할 수 있는 환경에서도 역할 컨텍스트 분리는 유지하지만, 이를 다른 공급자 간 교차 모델 검증과 동등하게 표기하지 않는다. 교차 모델 검증이 불가능할 때는 `UNVERIFIED`를 명시하고 사람이 확인할 항목을 강화한다. 모델 리뷰를 대신할 결정적 수단으로는 뮤테이션 검사(`verify --mutation-probe`)를 지원한다.

## 비용 효율적 모델 분리 라우팅 (`scripts/lib/model-router.mjs`, `scripts/route.mjs`)

| 티어 | 대상 작업 | 비용·호출 정책 |
|---|---|---|
| `deterministic` | `verify`, `impact_analysis`, `scope_check`, `schema_validate`, `test_select` | 0 LLM 호출 (결정적 스크립트) |
| `lightweight` | `classify`, `triage`, `summarize`, `log_digest`, `search`, `explore` | 경량 모델 힌트 (`haiku` / `flash_lite` 또는 설정값) |
| `standard` | `implement`, `refactor`, `write_tests`, `repair` (1차) | 표준 모델 힌트 (`sonnet` / `flash` 또는 설정값) |
| `reasoning` | `architecture`, `security_review`, `conflict_resolution`, `retry_round >= 2` | 고성능 추론 모델 (`opus` / `pro` 또는 설정값) |

단일 모델 환경(`supports_multi_model === false`)에서는 `degraded_to_single_model: true`와 제한 사유를 함께 기록한다. 호스트별 모델 티어 매핑은 `options.modelTiers` > 계약이나 저장소 `.crafthelm/config.json`의 `host_profiles[host]` 및 `model_tiers` > 환경 변수(`CRAFTHELM_MODEL_LIGHTWEIGHT`, `CRAFTHELM_MODEL_STANDARD`, `CRAFTHELM_MODEL_REASONING`) > 내장 호스트 기본값 순서로 해석한다. 인세션 IDE나 커스텀 호스트가 다중 모델을 지원하면 `host_config.supports_multi_model: true`로 선언한다.

## 위임 실행 기록 (`scripts/delegate.mjs`)

라우팅 결과는 힌트일 뿐이므로, 위임이 실제로 있었는지는 기록으로 남긴다. 기록은 `.crafthelm/runs/<run>/delegations/D###.json`에 쌓이고 `delegation-record.schema.json`으로 검증한다.

| 경로 | 명령 | `observation` | 사용량 |
|---|---|---|---|
| CLI 호스트 (`claude`, `codex`, `agy`, 커스텀 CLI) | `delegate run ... --execute` | `observed` | 어댑터가 읽은 실측값, 못 읽으면 `"unknown"` |
| 인세션 호스트 (네이티브 서브에이전트) | `delegate record --packet <json>` | `self_reported` | 항상 `"unknown"` |

- `delegate run`은 `routeTask`로 티어와 모델을 정한 뒤 활성 호스트 어댑터의 `dispatch`만 호출한다. 다른 공급자 CLI는 부르지 않는다. `--execute`가 없으면 준비된 명령만 출력하고 기록하지 않는다.
- 워커의 원시 출력은 `delegations/D###.output.txt`에 저장하고 Lead에는 경로만 돌려준다.
- 스크립트는 인세션 서브에이전트를 띄울 수 없다. 그 경우 Lead가 아래 Lead Context Contract 형식의 결과 패킷을 `delegate record`로 제출하며, 형식에 없는 필드(원시 로그 등)가 있으면 거부한다.
- `verify`는 위임 요약을 증거 매니페스트의 `delegation`에 넣고 검토 보고서 1절에 표시한다. 상태는 `OBSERVED`, `SELF_REPORTED`, `MIXED`, `UNOBSERVED` 중 하나다. 기록이 없으면 `UNOBSERVED`이며, 역할·모델 분리가 있었다고 적지 않는다.

## Lead Context Contract

Worker는 원시 전체 로그를 Lead에 넘기지 않고 `task_id`, `status`, `acceptance[]`, `changed_files`, `scope_violation`, `root_cause`, `decision_needed`, `artifact_refs` 요약만 전달한다.
