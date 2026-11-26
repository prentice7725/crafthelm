# Benchmarking & Metric Policy

## 비교군

- A: 순정 Claude Code 또는 Codex에서 상위 모델이 단독으로 작업을 마친다.
- B: CraftHelm에서 동일 공급자·동일 상위 모델 Lead와 허용된 경량 Worker를 함께 사용한다.
- C: CraftHelm을 단일 모델 모드로 사용한다.

## 정직한 측정 규칙

1. 동일 초기 tree, 동일 명세, 동일 테스트, 동일 호스트 버전을 사용한다.
2. 실측되지 않은 토큰 수와 비용은 추정치로 채우지 않고 `"unknown"`으로 기록한다.
3. 비교군은 품질과 보안 비열화 여부, 완료율 유지 이상, Lead 사용량 감소, 총 비용·시간·사용자 개입 순서로 평가한다.
4. 실측(`benchmark live`)은 호스트 CLI를 실제로 호출해 토큰을 쓰므로 `--i-accept-cost` 없이는 시작하지 않는다.
5. 검증기 자체 평가는 고정 평가 세트(알려진 결함 + 정상 변경 통제군)로 `raw → verified → final` recall과 `false_positive_rate`를 분리 측정한다.

## 실측 비교 (`benchmark live`, `scripts/lib/benchmark-live.mjs`)

고정 과제 3개(`L01` 버그 수정, `L02` 기능 추가, `L03` 동작 보존 리팩터링)를 비교군마다 새 임시 저장소에서 한 번씩 실행한다.

| 비교군 | 실행 방식 |
|---|---|
| A | 어댑터 `dispatch`로 상위 티어 모델에 요청만 전달 |
| B | 인터뷰·계약·기준선 생성 후 `delegate run --execute`로 라우팅된 티어의 워커 실행, 결정적 `verify` |
| C | B와 같되 워커를 호스트 기본 단일 모델로 실행 |

- 측정 항목: 호스트 CLI가 보고한 워커 호출의 입력·출력 토큰, 캐시 읽기·쓰기 토큰, 비용, 실제로 과금된 모델(`models_used`), 소요 시간, 워커가 보지 못한 숨은 검사(`tests/hidden.check.mjs`) 통과 여부다. Claude CLI의 입력 토큰은 캐시된 프롬프트를 빼고 센 값이라 캐시 열을 함께 본다.
- 측정하지 않는 항목: B와 C에서는 하네스가 Lead 역할을 결정적으로 대신하므로 대화형 Lead가 쓰는 토큰(`lead_tokens: "unknown"`)이 빠진다. 따라서 B·C 수치는 실제 CraftHelm 세션 비용의 하한이다.
- 해석 한계: 과제당 1회 실행이므로 모델 출력 편차 때문에 이 표본만으로 일반적인 절감률을 주장하지 않는다. 절감률을 판단하려면 과제와 반복 횟수를 늘려야 한다.

```bash
node scripts/crafthelm.mjs benchmark live --host claude --i-accept-cost --output reports/live-benchmark.md
```

## 실측 기록

- [2026-11-24, Claude Code 2.1.311](benchmarks/2026-11-24-claude-live.md): 9회 모두 숨은 검사 통과, 워커 비용 A $0.78 / B $0.40 / C $0.78. 표본이 작고 리드 토큰이 빠져 있어 절감률 근거로 쓰지 않는다.
