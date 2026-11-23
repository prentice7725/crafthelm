# CraftHelm — 사람의 인수 검토 보고서 v0.3

> **상태: 검토 대기 (READY_FOR_HUMAN_REVIEW)**  
> 이 문서는 *템플릿*입니다. 실제 코드·테스트를 실행한 결과가 아니며, `{{...}}`는 실행 시 실제 증거로 대체해야 합니다.  
> **책임 경계:** 자동 검사는 검사 조건만 확인합니다. AI의 검토 의견은 참고자료입니다. 인수 또는 반려는 승인자가 결정합니다.

## 1. 지금 결정해야 할 것

| 항목 | 내용 |
|---|---|
| 작업 | `{{task_id}}` — {{human_readable_title}} |
| 이번 승인 대상 | {{scope_of_change}} |
| 승인하면 달라지는 것 | {{user_visible_behavior}} |
| 자동 검증 상태 | **{{technical_status}}** — 근거: `{{evidence_manifest_link}}` |
| 검증 수준 | **{{none_partial_verified}}** — `none/partial/verified`는 수행된 기술 검사의 범위만 의미 |
| 승인 대상 스냅샷 | `{{target_snapshot_digest}}` — 검증 스탬프: `{{verification_stamp_link}}` |
| 실제 서비스/앱 실행 검증 | **{{e2e_pass_fail_blocked_unverified}}** — 재현 링크: `{{e2e_evidence_link_or_none}}` |
| 아직 확인되지 않은 것 | {{unverified_summary_or_none}} |
| 사람의 결정 | **미결정** — `승인 / 수정 요청 / 추가 검증 / 반려` |

**판단을 위해 확인할 핵심 질문:** {{most_important_human_question}}

## 2. 변경 내용

### 변경 전

{{before_behavior_with_source}}

### 변경 후

{{after_behavior_with_reference_to_diff}}

**영향 범위:** {{systems_users_operations_affected}}  
**호환성·되돌리기:** {{compatibility_and_rollback}}

## 3. 요구사항과 검증 결과

| 요구 ID | 기대 동작 | 확인 방법 | 자동 검사 결과 | 근거 | 사람이 확인할 항목 |
|---|---|---|---|---|---|
| `{{req_id_1}}` | {{expected_1}} | {{method_1}} | {{PASS_FAIL_BLOCKED_UNVERIFIED}} | `{{link_1}}` | {{manual_check_1}} |
| `{{req_id_2}}` | {{expected_2}} | {{method_2}} | {{PASS_FAIL_BLOCKED_UNVERIFIED}} | `{{link_2}}` | {{manual_check_2}} |

> `PASS`는 기술 검사 결과이지 인간의 인수 승인을 뜻하지 않습니다. 표에 없는 요구사항이나 수행하지 못한 검사는 `UNVERIFIED`로 기록합니다.

## 4. 직접 확인할 시나리오

1. **{{scenario_title_1}}** — 사전 조건 {{precondition}} → 실행 {{action}} → 기대 결과 {{expectation}}.
2. **{{scenario_title_2}}** — 사전 조건 {{precondition}} → 실행 {{action}} → 기대 결과 {{expectation}}.

**자동 복구 시도:** {{repair_attempt_count}}회 / 상한 {{repair_limit}}회  
**실패가 지속되는 경우 사람에게 필요한 결정:** {{escalation_decision_or_none}}

**재현 환경:** {{runtime_os_versions_dependencies}}  
**재현 명령:** `{{command_or_not_available}}`

## 5. 실행 검증의 범위와 한계

| 검증 유형 | 적용 이유 | 상태 | 증거/반례 | 검토자가 재확인할 일 |
|---|---|---|---|---|
| E2E Smoke | {{e2e_reason}} | {{e2e_status}} | `{{e2e_evidence}}` | {{e2e_manual_followup}} |
| Property | {{property_applicability}} | {{property_status}} | `{{property_seed_counterexample_or_na}}` | {{property_followup}} |
| Differential | {{diff_applicability}} | {{diff_status}} | `{{old_new_comparison_or_na}}` | {{diff_followup}} |
| Reliability Rules | {{matched_diff_triggers}} | {{reliability_status}} | `{{rule_evidence}}` | {{rule_manual_followup}} |

**검증 정책 기준:** `{{policy_base_ref}}` / `{{policy_digest}}`  
**기준 미충족·차단 사유:** {{blocked_or_unverified_detail}}  
**검증 대상이 달라졌는가:** {{same_snapshot_yes_no}} — 다르다면 기존 검증 결과는 `STALE`로 표기하고 재검사합니다.

## 6. 위험 및 미해결 사항

| 심각도 | 문제 | 영향 | 권고 | 결정권자 |
|---|---|---|---|---|
| {{severity}} | {{risk_or_gap}} | {{impact}} | {{mitigation_or_question}} | {{owner}} |

`{{critical_unresolved_issues_or_explicit_none}}`

## 7. 근거 자료

| 자료 | 식별자/경로 | 확인 사항 |
|---|---|---|
| 계약 기준선 | `{{contract_digest}}` | 승인된 범위와 수용 기준 |
| 원본 코드 상태 | `{{baseline_git_ref}}` | 변경 시작점 |
| 최종 코드 상태 | `{{final_tree_digest}}` | 이번 인수 대상 |
| 변경 목록 | `{{diff_link}}` | 수정 범위 |
| 자동 테스트 로그 | `{{test_log_links}}` | 실행 증거 |
| 검증 스탬프 | `{{verification_stamp_link}}` | 코드 스냅샷/검증 정책/실행 검사 연결 |
| E2E 재현 또는 트레이스 | `{{e2e_evidence_link}}` | 사용자 흐름을 실제로 실행한 기록 |
| Reliability 검사 | `{{reliability_checks_link}}` | 변경 사항에 대응하는 검증 규칙과 선택 이유 |
| AI 리뷰 의견 | `{{review_findings_link}}` | 참고 의견이며 자동 확정 아님 |
| 문서 교열 보고 | `{{editorial_report_link}}` | Kouetsu의 문서 개선·맹점 지적; 사실 검증과 별개 |

**출처 미확인·링크 누락·자료 없음**은 숨기지 않고 이 표에 표시합니다. 문서 교열을 실제 수행하지 않았다면 `미실행`으로 기록합니다.

## 8. 검토자의 결정

현재 상태: **미승인 (PENDING)**

가능한 결정:

- **인수 승인:** 변경 범위와 남은 위험을 확인하고 인수합니다.
- **수정 요청:** 문제와 관련 요구 ID·재현 조건을 전달합니다.
- **추가 검증:** 필요한 증거나 사용자 테스트를 지정합니다.
- **반려:** 이번 산출물을 인수하지 않습니다.

결정이 입력될 때만 사람 승인 레코드를 생성하며 `actor`, 실제 기록 시각, `contract_digest`, `report_digest`, `evidence_digest`, 근거, 수락 위험을 저장합니다. AI가 이 칸을 임의로 채우거나 승인으로 해석하지 않습니다.

---

### 작성 및 교열 기준

작성 단계에서는 읽는 사람, 결정해야 할 내용, 근거가 필요한 주장, 누락된 판단을 먼저 확인합니다. 이후 `kouetsu`의 **Content → Clarity → Surface** 순서로 교열하고, 긴 문서에는 별도 독자 검토를 수행합니다. 교열 여부를 보고에 명시하며, 교열 통과를 코드 품질 또는 사실 확인의 증거로 취급하지 않습니다.
