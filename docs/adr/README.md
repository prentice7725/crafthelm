# Architecture Decision Records (Initial M0 Baseline)

| ADR | 결정 | 이유 |
|---|---|---|
| ADR-001 | 새 저장소 `crafthelm` | 기존 `hyperfusion`을 독립 유지 |
| ADR-002 | 단일 공급자·한 개 CLI로 완결 | 실무 도입 장벽 및 구독 의존성 감소 |
| ADR-003 | Native-first, 자체 LLM 브로커 배제 | 중복 구현 및 복잡도 최소화 |
| ADR-004 | Lead의 직접 작업은 예외적으로 허용 | 작은 작업의 위임 손익 악화 방지 |
| ADR-005 | Methodology 4축 조합 | Waterfall/SDD/TDD의 서로 다른 차원 구분 |
| ADR-006 | 계약 승인 후 Full Loop | 자율성과 사용자 통제 동시 보장 |
| ADR-007 | 자동 기술 검증 + **사람의 최종 인수 승인** | 기술적 PASS와 책임 있는 완료 판단 분리 |
| ADR-008 | 외부 Skill 허용목록과 버전 고정 | 재사용 극대화 + 공급망·권한 통제 |
| ADR-009 | 검사 기준 자동 완화 금지 | Learning Loop의 보상 해킹 방지 |
| ADR-010 | M0 실측 우선, 기능 확장 후순위 | 비효율적인 엔진 비대화 억제 |
| ADR-011 | Kouetsu를 사람용 문서 교열 스킬로 재사용 | 독자가 지불하는 해석·검증 비용 감소 |
| ADR-012 | 문장 교열과 시각적 레이아웃 렌더링 분리 | Kouetsu의 현재 기능 범위와 부합 |
| ADR-013 | 자동 완료는 `READY_FOR_HUMAN_REVIEW`까지만 | 인간의 최종 책임을 기계적 증거와 구별 |
