# Workflow Contract & State Machine

## 실행 방식

- 전체 루프(`execution: "full"`): 계약 승인(`CONTRACT_PENDING -> READY`) 뒤 기술 단계를 순서대로 실행해 `READY_FOR_HUMAN_REVIEW`까지 산출물과 증거를 만든다. 사람의 결정 입력 전에는 `ACCEPTED`로 넘어가지 않는다.
- 단계 실행(`stage --to` 또는 `--only`): 지정 단계의 진입 조건을 검증한 뒤 실행하고 산출물을 저장한다.
- 작업 재개(`checkpoint resume`): `git_head`, `contract_sha256`, `skill_lock_sha256`, 보호 경로 해시, 스냅샷 해시를 대조한다. 계약·수용 기준·SOT 원문이 달라졌으면 `REPLAN_REQUIRED`로 전환한다. 이전 상태가 `READY_FOR_HUMAN_REVIEW`나 `ACCEPTED`일 때는 증거 매니페스트, 검토 보고서, 저장된 증거 로그의 SHA-256과 (`ACCEPTED`인 경우) 승인 결정 서명·보호된 승인자 정책까지 다시 확인한다. 하나라도 맞지 않으면 상태를 `VERIFYING`으로 되돌리고 `STALE_ARTIFACTS_CANNOT_RESTORE`를 반환한다.
- 실행 프로필(`process_profile`): 계약의 `process_profile`은 `full`(기본값) 또는 `lite`다. `lite`는 작은 버그 수정에 한해 E2E 요구를 조건부로 면제하며(`docs/quality-contract.md` 13항), 상태 전이 규칙과 사람의 최종 인수 절차는 `full`과 같다.
- 단일 writer 락(`checkpoint acquire-lock --writer <id>`): 실행에 락이 걸려 있으면 `verify`(`--record-red`·`--record-baseline-green` 포함), `feedback`, `review-package`, `checkpoint stage`·`transition`·`record-repair`·`replan`·`resume`은 `CONCURRENT_WRITER_BLOCKED`로 멈춘다. 락을 잡은 쪽은 같은 `--writer <id>`를 넘겨 통과한다. 락은 프로세스가 아니라 writer 이름에 걸리며 락을 잡는 명령은 곧바로 끝나므로, 기록된 PID만으로는 버려진 락을 가려낼 수 없다. 남은 락은 사람이 `checkpoint release-lock --run-id <id> --force`로 푼다.
- 기준선 지정(`checkpoint init --baseline-ref <commit>`, `contract approve --init-run --baseline-ref <commit>`): 실행의 기준선은 기본으로 실행을 여는 시점의 `HEAD`다. 그 전에 이미 커밋된 작업은 범위 검사, 영향도 분석, 변경 목록에 잡히지 않는다. 절차를 건너뛰고 먼저 커밋한 작업이 있으면 그 작업 직전의 커밋을 기준선으로 지정해 함께 검증한다. 기준선은 `HEAD`의 조상 커밋으로만 옮길 수 있어, 검증 대상을 넓힐 수는 있어도 좁힐 수는 없다.
- 재계획(`checkpoint replan`): 기존 결정문 이력을 덮어쓰지 않고 변경에 영향받는 단계와 테스트만 무효화한다.

## 상태 전이 규칙

- 허용 상태는 `NEW`, `DISCOVERY`, `INTERVIEWING`, `CONTRACT_PENDING`, `READY`, `RUNNING_STAGE`, `VERIFYING`, `REVIEWING`, `REPAIRING`, `REVIEW_PACKAGE_DRAFT`, `READY_FOR_HUMAN_REVIEW`, `ACCEPTED`, `CHANGES_REQUESTED`, `REJECTED`, `HANDOFF`, `CLOSED_UNACCEPTED`, `PAUSED`, `BLOCKED`, `BLOCKED_HUMAN_ATTENTION`, `ABORTED`, `RECONCILING`, `APPROVAL_REQUIRED`, `REPLAN_REQUIRED`다.
- `COMPLETE` 상태는 사용하지 않는다.
- `READY_FOR_HUMAN_REVIEW -> ACCEPTED` 전이는 `approvals/decision.json`의 `decision === "accepted"`와 일치하는 `contract_sha256`, `evidence_manifest_sha256`, `report_sha256`, `target_snapshot_digest`, 변조되지 않은 증거 로그 해시, 그리고 보호된 승인자 정책(`.crafthelm/approvers.json`)의 서명 조건이 모두 검증된 경우에만 허용한다.
- Waterfall 생명주기에서는 승인 게이트 단계(`requirements`, `architecture`, `detailed_design`, `integration`, `human_acceptance`)를 통과할 때 명시적 단계 승인을 요구한다.

## 재계획과 재승인의 기록 순서

- `checkpoint replan`은 트리 해시 계산을 모두 끝낸 뒤에 기록한다. 체크포인트를 먼저 원자적으로 쓰고 `approvals/replan-history.jsonl`에 한 줄을 덧붙인다. 계산 도중 중단되면 두 파일 모두 바뀌지 않는다. 스냅샷을 계산하며 읽은 파일 해시를 SOT 해시와 기준 파일 해시에 다시 쓰므로 큰 파일도 한 번만 읽는다.
- 이미 승인된 계약을 같은 승인자가 같은 경로로 다시 승인하면 아무것도 쓰지 않고 `already_approved: true`를 돌려준다. 승인 시각을 고쳐 쓰면 계약 해시가 바뀌어, 열려 있는 실행이 `CONTRACT_HASH_MISMATCH`로 재계획을 요구하게 되기 때문이다.
- 이미 있는 작업 ID로 `interview`를 다시 실행하면 `TASK_EXISTS`로 끝나고 계약은 그대로다. 바뀐 요청을 반영하려면 `--overwrite`로 다시 만들거나 `contract add-e2e`·`add-test`로 고친 뒤 승인한다.

## 인터뷰 입력의 요구사항 형식

- `--input` 파일의 `requirements`는 `{ "id": "REQ-01", "statement": "..." }` 객체의 배열이다. `id`와 `statement`가 필수이고 `source`, `status`, `assumption`, `approved_by`는 생략하면 기본값이 들어간다.
- 필수 필드가 없거나 다른 이름(`text` 등)으로 쓴 항목은 `INTERVIEW_INPUT_INVALID`로 거부하고 종료 코드 1로 끝난다. 아무 파일도 쓰지 않는다. 예전에는 `requirements.md`에 `undefined`가 찍힌 채 종료 코드 0으로 끝났다.
- 요구사항 문구는 계약의 `requirements`에도 들어간다. 사람이 승인하는 문서와 그 해시에 "무엇을 하는가"가 포함되게 하려는 것이다. 이 필드가 없는 기존 계약은 그대로 유효하다.
