# Delegation Policy — Lead Token Firewall

## 역할과 비용 경계

- **Lead:** 아키텍처·요구 충돌·고위험 의사결정·최종 검토 패키지 구성 판단. 1~2파일 단순 수정은 위임 오버헤드가 더 크면 직접 처리할 수 있다.
- **Explorer / Planner / Builder / Reviewer / Learning Curator:** 호스트 네이티브 Subagent 또는 독립 세션.
- **Verifier:** 가능한 한 모델 없는 결정적 스크립트(`scripts/verify.mjs`).

## 단일 모델 환경 규칙

단일 모델만 사용 가능한 환경에서도 역할 컨텍스트 분리는 유지할 수 있으나, 이를 다른 공급자 간 교차 검증과 동등하게 표기하지 않는다. 교차 모델 검증이 불가능할 때는 `UNVERIFIED`를 명시하고 사람 확인 항목을 강화한다.

## 비용 효율적 모델 분리 라우팅 (`scripts/lib/model-router.mjs`, `scripts/route.mjs`)

| 티어 | 대상 작업 | 비용/호출 정책 |
|---|---|---|
| `deterministic` | `verify`, `impact_analysis`, `scope_check`, `schema_validate`, `test_select` | 0 LLM 호출 (결정적 스크립트) |
| `lightweight` | `classify`, `triage`, `summarize`, `log_digest`, `search`, `explore` | 경량 모델 힌트 (`haiku` / `flash_lite` 또는 설정값) |
| `standard` | `implement`, `refactor`, `write_tests`, `repair` (1차) | 표준 모델 힌트 (`sonnet` / `flash` 또는 설정값) |
| `reasoning` | `architecture`, `security_review`, `conflict_resolution`, `retry_round >= 2` | 고성능 추론 모델 (`opus` / `pro` 또는 설정값) |

단일 모델 환경(`supports_multi_model === false`)에서는 `degraded_to_single_model: true`와 제한 사유를 명시한다.  
호스트별 모델 티어 매핑은 `options.modelTiers` > 계약/저장소 `.crafthelm/config.json`의 `host_profiles[host]` 및 `model_tiers` > 환경 변수(`CRAFTHELM_MODEL_LIGHTWEIGHT`, `CRAFTHELM_MODEL_STANDARD`, `CRAFTHELM_MODEL_REASONING`) > 내장 호스트 기본값 순으로 해석한다. 인세션 IDE 또는 커스텀 호스트가 다중 모델을 지원하는 경우 `host_config.supports_multi_model: true`로 선언할 수 있다.

## Lead Context Contract

Worker는 원시 전체 로그를 Lead에 넘기지 않고 `task_id`, `status`, `acceptance[]`, `changed_files`, `scope_violation`, `root_cause`, `decision_needed`, `artifact_refs` 요약만 전달한다.
