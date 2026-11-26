# Interview Policy

## 원칙

1. 대상 프로젝트의 `README.md`, `docs/`, `package.json`, 기존 테스트, 최근 Git 이력을 먼저 읽고 이미 문서에서 확인되는 내용은 질문하지 않는다(`Source First`).
2. 확인되지 않은 불확실성은 세 등급으로 나눈다.
   - `BLOCKER`: 요구사항 충돌, 보안·데이터 손실·외부 비용·제품 핵심 결정. 해소되기 전에는 자율 실행으로 넘어가지 않는다.
   - `ASSUMABLE`: 통상적 구현 상세. 기본값·근거·되돌리기 비용을 기록하고 계약을 만든다.
   - `DEFERRED`: 현재 작업 범위에 영향을 주지 않는 미결 사항. `open_questions.md` 백로그에 남긴다.
3. 비대화형 환경에서 `BLOCKER`가 남아 있으면 가정으로 메우지 않고 `INTERVIEW_REQUIRED`를 반환한다.
4. 인터뷰가 끝나면 `requirements.md`, `decisions.md`, `open_questions.md`, `acceptance.md`, `interview_questions.md`, `.crafthelm/contracts/<task-id>.json`을 출력한다.
5. 인터뷰 중에 전체 루프 자율 실행을 허용받았더라도 이는 구현·검증 실행 권한일 뿐, 최종 인수 승인을 뜻하지 않는다.

## 결정적 질문 생성 (`scripts/lib/interview-questions.mjs`)

인터뷰는 전달받은 불확실성만 분류하지 않고, 저장소 신호와 요청 문구에서 질문을 직접 만든다. 모델 호출은 없다.

| 질문 ID | 발생 조건 | 수준 | 답하는 방법 |
|---|---|---|---|
| `Q-ACCEPTANCE` | 동작 변경인데 수용 기준을 주지 않았다 | BLOCKER | `acceptance` |
| `Q-NO-TESTS` | 저장소에 테스트 파일이 없다 | BLOCKER | `acceptance` |
| `Q-SCOPE` | `scope.allow`를 주지 않았다 | 기본 범위에 맞는 파일이 없으면 BLOCKER, 있으면 ASSUMABLE | `scope.allow` |
| `Q-REPRO` | `change_kind`가 `bugfix`이다 | BLOCKER | `reproduction` |
| `Q-BASELINE` | `change_kind`가 `refactor`이다 | BLOCKER | `acceptance` |
| `Q-RISK-DATA` / `Q-RISK-SECURITY` | 요청 문구가 데이터 삭제·이관이나 인증·권한을 가리킨다 | BLOCKER | 같은 ID의 `uncertainties[].answer` |
| `Q-RISK-COMPATIBILITY` | 요청 문구가 공개 인터페이스·버전·이름 변경을 가리킨다 | ASSUMABLE | 같은 ID의 `uncertainties[].answer` |
| `Q-DECISION-<id>` | 기록된 결정의 제목이 요청 문구와 겹친다 | ASSUMABLE | 같은 ID의 `uncertainties[].answer` |
| `Q-VAGUE-REQUEST` | 요청이 네 단어 미만이다 | ASSUMABLE | 요청 문구 보강 |

문구 판별은 한국어·영어·일본어 키워드 정규식으로 동작한다. 키워드에 걸리지 않은 위험은 잡지 못하므로, 아래 영역별 검토가 빈자리를 드러내는 역할을 한다.

## 영역별 검토 여부 (`uncertainty_coverage`)

`scope`, `acceptance`, `data`, `security`, `compatibility` 다섯 영역마다 `addressed` 또는 `unaddressed`를 기록한다. 질문이 하나도 생성되지 않았고 근거도 선언되지 않은 영역은 "문제없음"이 아니라 `unaddressed`다. 해당 없음을 주장하려면 입력에 근거 출처를 적는다.

```json
{ "uncertainty_coverage": { "data": { "basis": "src/auth.mjs만 변경, 저장 계층 코드 없음 (README.md)" } } }
```

## 기본 모드와 엄격 모드

- 기본 모드에서는 생성된 질문과 영역별 검토 결과를 `interview_questions.md`와 결과 JSON(`generated_questions`, `uncertainty_coverage`)에 남기고 계약을 만든다. 미답변 질문은 가정 아래 진행된 것으로 기록한다.
- 엄격 모드(`--strict-interview` 또는 `.crafthelm/config.json`의 `{"interview": {"strict": true}}`)에서는 미답변 `BLOCKER` 질문이나 `unaddressed` 영역이 하나라도 있으면 `INTERVIEW_REQUIRED`를 반환한다.
