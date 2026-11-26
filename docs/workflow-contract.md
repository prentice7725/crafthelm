# Workflow Contract & State Machine

## 실행 스타일

- **Full Loop:** 계약 승인(`CONTRACT_PENDING -> READY`) 이후 기술 단계를 자동 실행하여 `READY_FOR_HUMAN_REVIEW`까지 산출물과 증거를 생성한다. 최종 인수(`ACCEPTED`)는 사람의 결정 입력 전까지 진입할 수 없다.
- **Stage Mode:** 지정 단계(`--to` 또는 `--only`)의 진입 조건을 검증한 후 실행하고 산출물을 저장한다.
- **Resume:** `git_head`, `contract_sha256`, `skill_lock_sha256`, 보호 경로 및 스냅샷 해시를 대조한다. 계약/수용기준/SOT 변경 시 `REPLAN_REQUIRED`로 전환한다.
- **Process Profile:** 계약의 `process_profile`은 `full`(기본) 또는 `lite`다. `lite`는 작은 버그 수정에 한해 E2E 요구를 조건부로 면제하며(`docs/quality-contract.md` 13항), 상태 전이와 사람의 최종 인수 절차는 `full`과 같다.
- **단일 writer 락:** `checkpoint acquire-lock --writer <id>`로 잡은 락이 있으면 `verify`, `feedback`, `review-package`, `checkpoint stage`·`replan`·`resume`은 `CONCURRENT_WRITER_BLOCKED`로 멈춘다. 락을 잡은 쪽은 같은 `--writer <id>`를 넘겨 통과한다. 락은 프로세스가 아니라 writer 이름에 걸리며, 락을 잡는 명령은 곧바로 끝나므로 기록된 PID로는 버려진 락을 가려낼 수 없다. 남은 락은 사람이 `checkpoint release-lock --run-id <id> --force`로 푼다.
- **Replan:** 기존 결정문 이력을 덮어쓰지 않고 영향받는 단계·테스트만 무효화한다.

## 상태 전이 규칙

- 허용 상태: `NEW`, `DISCOVERY`, `INTERVIEWING`, `CONTRACT_PENDING`, `READY`, `RUNNING_STAGE`, `VERIFYING`, `REVIEWING`, `REPAIRING`, `REVIEW_PACKAGE_DRAFT`, `READY_FOR_HUMAN_REVIEW`, `ACCEPTED`, `CHANGES_REQUESTED`, `REJECTED`, `HANDOFF`, `CLOSED_UNACCEPTED`, `PAUSED`, `BLOCKED`, `BLOCKED_HUMAN_ATTENTION`, `ABORTED`, `RECONCILING`, `APPROVAL_REQUIRED`, `REPLAN_REQUIRED`.
- **금지 상태:** `COMPLETE`는 사용하지 않는다.
- `READY_FOR_HUMAN_REVIEW -> ACCEPTED`는 `approvals/decision.json`의 `decision === "accepted"` 및 일치하는 `contract_sha256`, `evidence_manifest_sha256`, `report_sha256`, `target_snapshot_digest`가 검증된 경우에만 허용된다.
- Waterfall 생명주기에서는 승인 게이트 단계(`requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance`) 통과 시 명시적 단계 승인이 필요하다.
