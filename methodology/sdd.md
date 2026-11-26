# SDD (Specification-Driven Development)

- 요구사항을 버전 있는 명세(`requirements.md`)로 생성하고 `REQ-ID → ARCH/DESIGN-ID → TASK-ID → AC-ID` 추적을 유지한다.
- 모순과 누락(`BLOCKER`)이 해결된 뒤에만 구현 단계로 넘어간다.
- 승인된 명세가 바뀌면 `replan`으로 영향받는 작업과 테스트를 무효화한다.
