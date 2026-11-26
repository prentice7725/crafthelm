# Architecture — CraftHelm v0.3

CraftHelm은 공통 JSON Schema 계약 위에서 호스트별 어댑터와 로컬 검증 스크립트를 분리해 동작한다. 에이전트는 호스트 네이티브 어댑터를 통해 작업하고, 상태 관리·범위 차단·검증·승인 기록은 로컬 Node.js 스크립트가 맡는다.

## 계층 구조

1. **인터뷰와 계약 생성 (`scripts/interview.mjs`, `scripts/contract.mjs`):** 저장소 문서와 이력을 먼저 읽고, 요청 문구와 저장소 신호에서 질문을 만든다(`interview_questions.md`). 미결 사항을 `BLOCKER`·`ASSUMABLE`·`DEFERRED`로 분류해 `requirements.md`, `decisions.md`, `open_questions.md`, `acceptance.md`, 실행 계약(`execution-contract.json`)을 생성한다.
2. **방법론 조합 (`scripts/lib/methodology.mjs`):** 계약의 `lifecycle`, `specification`, `engineering`, `execution` 네 설정 조합을 표준 12단계 계획으로 변환한다.
3. **호스트 네이티브 어댑터 (`hosts/registry.mjs`, `hosts/*/adapter.mjs`):** `claude`, `codex`, `antigravity`, `generic` 어댑터가 `discoverCapabilities`, `selectWorker`, `dispatch`, `collectResult`, `requestApproval`, `observeUsage`, `captureSessionContext` 7개 포트 계약을 구현한다. 각 어댑터는 지정된 공급자만 사용하며 다른 공급자 CLI를 부르지 않는다.
4. **상태와 체크포인트 (`scripts/checkpoint.mjs`, `scripts/lib/state-machine.mjs`):** 허용된 상태 전이만 통과시키고, 단일 writer 락·Waterfall 단계 승인 게이트·3라운드 자동 수정 상한·재개/재계획 시 해시와 로그 무결성을 검사한다. 장기 기억은 `scripts/memory.mjs`가 Markdown 원문과 `node:sqlite` FTS5 색인으로 관리한다.
5. **실행 검증과 사전 차단 (`scripts/verify.mjs`, `scripts/lib/scope-guard.mjs`, `scripts/lib/impact-analysis.mjs`, `scripts/lib/mutation-probe.mjs`):** Claude Code에서는 `PreToolUse` 범위 가드 훅이 쓰기 전에 범위 위반과 통제 파일 수정을 막는다. `verify`는 보호된 `policy_base_ref` 기준선 정책을 읽어 변경 범위, 보호 경로, 수용 기준, 다언어 영향도 기반 선택적 회귀 테스트, Diff 기반 신뢰성 규칙, 증거 강도, 뮤테이션 검사를 실행하고 검증 스탬프와 증거 매니페스트를 남긴다.
6. **검토 보고서 발행과 교열 (`scripts/review-package.mjs`, `scripts/lib/kouetsu-check.mjs`):** 8개 섹션 Human Review Package를 생성하고, 저장된 증거 로그 해시·파일 링크·수용 기준 일치를 검증한 뒤 Kouetsu 3계층(내용·명확성·표면) 교열을 통과한 경우에만 `READY_FOR_HUMAN_REVIEW`로 올린다.
7. **사람의 최종 인수 (`scripts/approval.mjs`):** AI 에이전트 세션과 비대화형 실행을 차단하고 지정 승인자의 결정(`accepted`, `changes_requested`, `rejected`, `verification_requested`)과 `ed25519` 서명을 기록한다. 코드·계약·증거·보고서·서명이 달라지면 기존 승인 효력을 즉시 무효화한다.
8. **외부 스킬 관리 (`scripts/skills.mjs`, `external-skills/registry.json`):** 외부 스킬의 정적 보안 감사, 단일 공급자 충돌 검사, SHA-256 고정을 담당한다.
