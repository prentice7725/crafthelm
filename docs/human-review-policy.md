# Human Review & Accountability Policy

## 책임 분리

- **자동 검사 PASS ≠ 인간 인수 승인.**
- `READY_FOR_HUMAN_REVIEW`는 검토 패키지 생성·Kouetsu 교열·증거 해시 고정이 완료된 상태일 뿐 완료(`ACCEPTED`)가 아니다.
- `approvals/decision.json`은 오직 `scripts/approval.mjs record`를 통한 명시적 사용자 입력으로만 생성된다.
- 로컬 M0에서 `actor`는 사용자 입력 문자열이며 암호학적 실명 인증으로 취급하지 않는다(`verification_type: "local_explicit_input_not_identity_verified"`).

## 승인 무효화 규칙

승인 이후 `target_snapshot_digest`, `contract_sha256`, `evidence_manifest_sha256`, `report_sha256` 중 하나라도 달라지면 기존 승인 효력은 즉시 무효화되며(`INVALIDATED`) 재검토가 필요하다.
