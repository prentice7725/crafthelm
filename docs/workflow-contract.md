# Workflow Contract & State Machine

## 실행 방식

- 전체 루프(`execution: "full"`): 계약 승인(`CONTRACT_PENDING -> READY`) 뒤 기술 단계를 순서대로 실행해 `READY_FOR_HUMAN_REVIEW`까지 산출물과 증거를 만든다. 사람의 결정 입력 전에는 `ACCEPTED`로 넘어가지 않는다.
- 단계 실행(`stage --to` 또는 `--only`): 지정 단계의 진입 조건을 검증한 뒤 실행하고 산출물을 저장한다.
- 작업 재개(`checkpoint resume`): `git_head`, `contract_sha256`, `skill_lock_sha256`, 보호 경로 해시, 스냅샷 해시를 대조한다. 계약·수용 기준·SOT 원문이 달라졌으면 `REPLAN_REQUIRED`로 전환한다. 이전 상태가 `READY_FOR_HUMAN_REVIEW`나 `ACCEPTED`일 때는 증거 매니페스트, 검토 보고서, 저장된 증거 로그의 SHA-256과 (`ACCEPTED`인 경우) 승인 결정 서명·보호된 승인자 정책까지 다시 확인한다. 하나라도 맞지 않으면 상태를 `VERIFYING`으로 되돌리고 `STALE_ARTIFACTS_CANNOT_RESTORE`를 반환한다.
- 실행 프로필(`process_profile`): 계약의 `process_profile`은 `full`(기본값) 또는 `lite`다. `lite`는 작은 버그 수정에 한해 E2E 요구를 조건부로 면제하며(`docs/quality-contract.md` 13항), 상태 전이 규칙과 사람의 최종 인수 절차는 `full`과 같다.
- 단일 writer 락(`checkpoint acquire-lock --writer <id>`): 실행에 락이 걸려 있으면 `verify`(`--record-red`·`--record-baseline-green` 포함), `feedback`, `review-package`, `checkpoint stage`·`transition`·`record-repair`·`replan`·`resume`은 `CONCURRENT_WRITER_BLOCKED`로 멈춘다. 락을 잡은 쪽은 같은 `--writer <id>`를 넘겨 통과한다. 락은 프로세스가 아니라 writer 이름에 걸리며 락을 잡는 명령은 곧바로 끝나므로, 기록된 PID만으로는 버려진 락을 가려낼 수 없다. 남은 락은 사람이 `checkpoint release-lock --run-id <id> --force`로 푼다.
- 재계획(`checkpoint replan`): 기존 결정문 이력을 덮어쓰지 않고 변경에 영향받는 단계와 테스트만 무효화한다.

## 상태 전이 규칙

- 허용 상태는 `NEW`, `DISCOVERY`, `INTERVIEWING`, `CONTRACT_PENDING`, `READY`, `RUNNING_STAGE`, `VERIFYING`, `REVIEWING`, `REPAIRING`, `REVIEW_PACKAGE_DRAFT`, `READY_FOR_HUMAN_REVIEW`, `ACCEPTED`, `CHANGES_REQUESTED`, `REJECTED`, `HANDOFF`, `CLOSED_UNACCEPTED`, `PAUSED`, `BLOCKED`, `BLOCKED_HUMAN_ATTENTION`, `ABORTED`, `RECONCILING`, `APPROVAL_REQUIRED`, `REPLAN_REQUIRED`다.
- `COMPLETE` 상태는 사용하지 않는다.
- `READY_FOR_HUMAN_REVIEW -> ACCEPTED` 전이는 `approvals/decision.json`의 `decision === "accepted"`와 일치하는 `contract_sha256`, `evidence_manifest_sha256`, `report_sha256`, `target_snapshot_digest`, 변조되지 않은 증거 로그 해시, 그리고 보호된 승인자 정책(`.crafthelm/approvers.json`)의 서명 조건이 모두 검증된 경우에만 허용한다.
- Waterfall 생명주기에서는 승인 게이트 단계(`requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance`)를 통과할 때 명시적 단계 승인을 요구한다.
