# Benchmarking & Metric Policy

## 비교군

- **A:** 순정 Claude Code 또는 Codex에서 상위 모델이 단독 수행.
- **B:** CraftHelm에서 동일 공급자·동일 상위 모델 + 허용된 경량 Worker 사용.
- **C:** CraftHelm 단일 모델 모드.

## 정직한 측정 규칙

1. 동일 초기 tree, 동일 명세, 동일 테스트, 동일 호스트 버전을 사용한다.
2. 실측되지 않은 토큰 수·비용은 절대 추정치로 채우지 않고 `"unknown"`으로 기록한다.
3. 판정 순서: **품질/보안 비열화 금지 → 완료율 유지 이상 → Lead 사용량 감소 → 총 비용·시간·사용자 개입 최소화**.
4. 검증기 자체 평가는 고정 평가 세트(알려진 결함 + 정상 변경 통제군)로 `raw → verified → final` recall과 `false_positive_rate`를 분리 측정한다.
