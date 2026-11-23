# Quality Contract & Verification Engineering

## 핵심 불변식

1. **Verification Is Executed Evidence:** 실제 프로그램을 실행한 stdout/stderr/exit code/trace로 판정한다.
2. **Protected Policy Baseline:** `REVIEW.md`, `.crafthelm/reliability-rules.json`, 보호 테스트 및 검증 설정은 승인된 `policy_base_ref`(`git show`) 또는 외부 보호 디렉터리에서 읽는다. 후보 브랜치가 수정한 검사 규칙을 평가 기준으로 쓰지 않는다.
3. **Snapshot Binding & Stale Detection:** 검증과 AI 리뷰는 특정 `target_snapshot_digest`에 결합된다. 이후 작업 트리가 바뀌면 기존 스탬프와 리뷰는 즉시 `STALE`이 된다.
4. **E2E Enforcement (`V01`):** 기능(`feature`) 또는 버그수정(`bugfix`) 변경에서 E2E smoke가 실패하거나 누락되면 단위 테스트가 모두 `PASS`여도 기술 승인을 차단한다.
5. **Property & Differential:** 불변식 위반 시 `seed`와 최소 `counterexample`을 보존하고(`V06`), 마이그레이션 비교 시 사전 승인된 `allowed_diffs` 외 차이는 `FAIL` 처리한다(`V07`).
6. **Diff-Triggered Reliability Rules:** 변경 경로/심볼이 매칭되는 규칙만 실행하고 비발동 사유를 기록한다. 신규 규칙은 `observe`로 도입하며, 승인 전까지 차단하지 않는다(`V05`).
7. **3-Round Repair Limit (`V04`):** 동일 원인 실패가 3라운드 지속되면 `BLOCKED_HUMAN_ATTENTION`으로 중단하고 최소 재현 명령·Diff·시도 이력·선택지를 사람에게 보고한다.
8. **No Flaky Silencing:** sleep 추가, 무한 재시도, 침묵 속 스킵을 금지한다.
9. **다언어 AST/콜 그래프 영향도 분석 및 안전한 회귀 테스트 선별 (`scripts/lib/impact-analysis.mjs`, `scripts/lib/impact-languages.mjs`, `scripts/lib/test-runners.mjs`, `verify --selective`):** Diff hunk와 다언어(JS/TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby, PHP) import·package·함수/클래스 콜 그래프 및 외부 커스텀 분석기(`custom_impact_analyzer`)를 결합해 직간접 영향 테스트만 선별하고 러너별 명령을 생성한다. 단, `e2e`/`always_run` 검사는 생략하지 않으며 전역 설정·스키마·미분석 소스 변경이나 매칭 0건 시 자동으로 전체 테스트(`fallback_to_full`)로 폴백한다.
10. **상한 있는 검증·피드백·승인 요청 루프 (`scripts/feedback-loop.mjs`):** 검증 실패 시 `evidence/feedback-packet.json`을 생성해 수정→재검증을 반복하고, 통과 시 Kouetsu 교열을 거친 Review Package(`READY_FOR_HUMAN_REVIEW`)를 발행해 사람에게 승인을 요청한다(`approvals/decision.json` 자동 생성 금지).
