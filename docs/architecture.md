# Architecture — CraftHelm v0.3

> **프로세스 계약은 공통, 실행은 네이티브.**

## 계층 구조

1. **Interview & Context Intake (`scripts/interview.mjs`):** SOT 우선 조사, 불확실성(`BLOCKER` / `ASSUMABLE` / `DEFERRED`) 분류, 실행 계약(`execution-contract.json`) 초안 생성.
2. **Methodology Composer (`scripts/lib/methodology.mjs`):** `lifecycle × specification × engineering × execution` 4축 조합을 표준 12단계 계획으로 변환.
3. **Host Native Adapter (`hosts/registry.mjs`, `hosts/claude/adapter.mjs`, `hosts/codex/adapter.mjs`, `hosts/antigravity/adapter.mjs`, `hosts/generic/adapter.mjs`):** `discoverCapabilities`, `selectWorker`, `dispatch`, `collectResult`, `requestApproval`, `observeUsage`, `captureSessionContext` 7개 포트 계약 구현. 단일 공급자 엄격 격리 및 임의 호스트/인세션 실행 지원.
4. **State & Checkpoint (`scripts/checkpoint.mjs`, `scripts/lib/state-machine.mjs`):** 상태 전이 검증, 단일 writer lock, Waterfall 단계 승인 게이트, 3라운드 자동 수정 상한, Resume/Replan 정합성 검사.
5. **Deterministic Evidence Gate (`scripts/verify.mjs`):** 보호된 `policy_base_ref` 기준선 정책 로드, 변경 범위/보호 경로 검사, AC 실행(`fast`/`unit`/`e2e`/`property`/`differential`/`manual`), diff-triggered reliability rules, `VerificationStamp` 및 `EvidenceManifest` 생성.
6. **Review Publisher & Kouetsu Gate (`scripts/review-package.mjs`, `scripts/lib/kouetsu-check.mjs`):** 8개 섹션 Human Review Package 생성, 링크/AC 교차 검증, Kouetsu(Content → Clarity → Surface) 교열 및 `READY_FOR_HUMAN_REVIEW` 발행.
7. **Human Review Gate (`scripts/approval.mjs`):** 지정 승인자의 명시적 결정(`accepted`, `changes_requested`, `rejected`, `verification_requested`)을 해시와 함께 기록하고 코드/보고서 변경 시 효력 무효화 감지.
8. **Skill Registry (`scripts/skills.mjs`, `external-skills/registry.json`):** 외부 Skill 감사·충돌 검사·SHA-256 Pinning.
