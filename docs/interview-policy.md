# Interview Policy

## 원칙

1. **Source First:** 대상 프로젝트의 `README.md`, `docs/`, `package.json`, 기존 테스트, 최근 Git 이력을 먼저 읽고 이미 확인된 질문을 반복하지 않는다.
2. **Uncertainty Triage:**
   - `BLOCKER`: 요구사항 충돌, 보안·데이터 손실·외부 비용·제품 핵심 결정. 해소되기 전에는 자율 실행으로 넘어가지 않는다.
   - `ASSUMABLE`: 통상적 구현 상세. 기본값·근거·되돌리기 비용을 기록하고 진행 가능하다.
   - `DEFERRED`: 현재 단계에 영향 없는 미결 사항. `open_questions.md` 백로그로 남긴다.
3. **Non-interactive Safety:** 비대화형 환경에서 `BLOCKER`가 남아 있으면 가정으로 메우지 않고 `INTERVIEW_REQUIRED`를 반환한다.
4. **Outputs:** `requirements.md`, `decisions.md`, `open_questions.md`, `acceptance.md`, `.crafthelm/contracts/<task-id>.json`.
5. **Boundary:** 인터뷰 중 받은 Full Loop 자율 실행 허가는 최종 인수 승인을 의미하지 않는다.
