# Quality Contract & Verification Engineering

## 핵심 불변식

1. `verify.mjs`는 실제 프로그램을 실행한 표준 출력, 표준 오류, 종료 코드, 트레이스로만 판정한다.
2. `REVIEW.md`, `.crafthelm/reliability-rules.json`, 보호 테스트와 검증 설정은 승인된 `policy_base_ref`(`git show`)나 외부 보호 디렉터리에서 읽는다. 후보 브랜치가 수정한 검사 규칙은 평가 기준으로 쓰지 않는다.
3. 검증 결과와 AI 리뷰는 특정 `target_snapshot_digest`에 묶인다. 이후 작업 트리가 바뀌면 기존 스탬프와 리뷰는 즉시 `STALE`이 된다.
4. `feature`나 `bugfix` 변경에서 E2E smoke 검사가 실패하거나 빠지면, 단위 테스트가 모두 `PASS`여도 기술 승인을 차단한다(`V01`). 유일한 예외는 13항의 경량 프로필 조건부 면제다.
5. 속성 검사(`V06`)에서 불변식 위반이 나오면 `seed`와 최소 `counterexample`을 보존한다. 마이그레이션 차분 검사(`V07`)에서는 사전 승인된 `allowed_diffs` 외의 차이가 나면 `FAIL`로 처리한다.
6. 신뢰성 규칙(`V05`)은 변경 경로와 심볼이 일치하는 규칙만 실행하고 비발동 사유를 남긴다. 새 규칙은 `observe` 상태로 도입하며 승인 전까지는 실행을 막지 않는다.
7. 같은 원인 실패가 3라운드 이어지면(`V04`) `BLOCKED_HUMAN_ATTENTION`으로 멈추고 최소 재현 명령, Diff, 시도 이력, 선택지를 사람에게 보고한다.
8. 테스트를 통과시키려고 `sleep`을 넣거나 무한 재시도하거나 실패를 조용히 건너뛰지 않는다.

## 상세 검증 규칙

### 9. 다언어 영향도 분석과 선택적 회귀 테스트 (`scripts/lib/impact-analysis.mjs`, `scripts/lib/impact-languages.mjs`, `scripts/lib/test-runners.mjs`, `verify --selective`)

Diff hunk와 다언어(JS/TS, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby, PHP) import·package·함수/클래스 콜 그래프, 그리고 외부 커스텀 분석기(`custom_impact_analyzer`)를 결합해 직간접 영향 테스트만 골라 러너별 명령을 만든다. 단, `e2e`와 `always_run` 검사는 생략하지 않으며 전역 설정·스키마·미분석 소스 변경이나 매칭 0건일 때는 전체 테스트(`fallback_to_full`)로 돌아간다.

### 10. 상한 있는 검증·피드백·승인 요청 루프 (`scripts/feedback-loop.mjs`)

검증에 실패하면 `evidence/feedback-packet.json`을 만들어 수정과 재검증을 반복한다. 통과하면 Kouetsu 교열을 거친 Review Package(`READY_FOR_HUMAN_REVIEW`)를 발행해 사람에게 승인을 요청한다. `approvals/decision.json`은 자동으로 만들지 않는다.

### 11. 증거 강도 등급 (`scripts/lib/evidence-strength.mjs`)

`PASS`는 명령이 기대한 종료 코드로 끝났다는 뜻일 뿐, 그 검사가 이번 변경을 다뤘다는 뜻은 아니다. `verify`는 수용 기준 실행 결과와 영향도 분석을 근거로 `evidence_strength`(`strong`, `moderate`, `weak`, `not_applicable`)를 증거 매니페스트에 기록하고, 검토 보고서 1절과 6절에 표시한다. 이 등급은 `technical_status`를 바꾸지 않으며 사람이 직접 확인할 항목을 알려 준다.

| 신호 | 등급 | 조건 |
|---|---|---|
| `NO_EXECUTED_PASSING_CHECK` | weak | 실행되어 통과한 수용 기준이 없다 |
| `NO_TEST_REACHES_CHANGE` | weak | 변경된 코드를 불러오거나 호출하는 테스트 파일이 없다 |
| `SINGLE_GENERIC_CHECK` | weak | 실행된 검사가 `kind: "test"` 범용 명령 하나뿐이다 |
| `NO_TEST_CHANGED` | moderate | `feature`/`bugfix`인데 추가·수정된 테스트가 없다 |
| `IMPACT_INCONCLUSIVE` | moderate | 영향도 분석이 그래프를 만들지 못해 도달 여부를 알 수 없다 |
| `MUTANTS_SURVIVED` | moderate (제거율 50% 미만이면 weak) | 뮤테이션 검사에서 살아남은 변이가 있다 |
| `TEST_FILE_DELETED` | weak | 테스트 파일이 삭제됐다 |
| `TEST_SKIP_ADDED` | weak | 테스트 파일에 skip·only·todo 표시가 추가됐다 (`it.skip`, `xit`, `{ skip: true }`, `@pytest.mark.skip`, `t.Skip()`, `#[ignore]`, `@Disabled` 등) |
| `ASSERTIONS_REMOVED` | moderate | 한 테스트 파일에서 삭제된 단언 줄이 추가된 단언 줄보다 많다 |

아래 세 신호(`scripts/lib/test-weakening.mjs`)는 코드를 고치는 대신 테스트를 끄거나 지워서 통과시킨 경우를 겨냥한다. 테스트 파일의 diff만 줄 단위로 읽으며, 해당 파일 경로를 신호의 `refs`와 검토 보고서 6절에 적는다. 파서를 쓰지 않으므로 사람이 확인할 후보일 뿐이고, 낡은 테스트를 정리한 정당한 변경에도 뜬다.

`docs`/`research` 변경과 소스 파일을 건드리지 않은 변경은 `not_applicable`이다. 단, 테스트 약화 신호가 하나라도 있으면 변경 종류와 상관없이 그 신호로 등급을 매긴다. 테스트만 바꾼 변경이 바로 실패하던 테스트를 끈 변경의 모양이기 때문이다. 도달 여부는 정적 import·호출 그래프 기준이므로 동적 로딩이나 리플렉션으로만 닿는 테스트는 잡지 못한다.

### 12. 뮤테이션 검사 (`scripts/lib/mutation-probe.mjs`, `verify --mutation-probe`)

단일 공급자 환경에서는 다른 계열 모델의 교차 리뷰를 쓸 수 없으므로, 테스트가 변경을 실제로 붙잡는지를 결정적으로 확인한다. 변경된 줄을 한 번에 하나씩 깨뜨리고(비교·불리언·산술 연산자 뒤집기, 뒤집을 연산자가 없는 줄은 문장 삭제) 통과했던 검사를 다시 돌려 실패하는지 본다. 실패하지 않은 변이는 "그 줄이 틀려도 테스트가 모른다"는 구체적인 증거이며 `evidence/mutation-probe.json`에 파일·줄·연산자로 남는다.

- 켜는 방법: `verify --mutation-probe [--max-mutants <n>]`, `feedback --mutation-probe`, 또는 계약의 `verification_policy.mutation_probe: true`. 기본값은 꺼짐이며, 변이 수만큼 검사를 반복하므로 시간이 든다(기본 상한 8개).
- 실행 시점은 E2E·경량 프로필 판정 직전이며, 신뢰성 규칙과 독립 리뷰 확인은 그보다 먼저 끝난다. 검사 결과와 상관없이 실패할 실행에서는 건너뛴다(`SKIPPED`). 인수 검사가 실패·차단됐거나 신뢰성 규칙·리뷰가 실패했거나 E2E가 이미 실패·누락으로 정해진 경우다. E2E 결과가 검사에 달린 경우는 E2E 검사가 없는 경량 계약뿐이다.
- 결과는 증거 강도 신호 `MUTANTS_SURVIVED`로 반영한다. 전체 프로필에서는 `technical_status`를 바꾸지 않는다. 경량 프로필에서는 이 신호로 증거 강도가 `weak`가 되면 E2E 면제가 취소된다(13항).
- 작업 트리 안전: 변이는 `finally`에서 원본 바이트로 복원하고 복원 후 해시를 대조한다. 실행 전 원본과 변이 후 해시를 실행 디렉터리에 원자적으로 기록해 두어, 중간에 프로세스가 죽어도 다음 `verify`가 스냅샷 계산과 인수 검사보다 먼저 복구한다. 복구는 검사를 다시 켜지 않아도 일어난다.
- 복구 기록은 작업 공간 안이라 누구나 쓸 수 있으므로 그대로 믿지 않는다. 대상이 저장소 밖이거나 `.git/`·`.crafthelm/` 아래면 거부하고(`JOURNAL_PATH_REJECTED`), 기록이 깨졌으면 거부하며(`JOURNAL_CORRUPT`), 파일이 그사이 수정돼 변이된 내용과 다르면 덮어쓰지 않는다(`FILE_CHANGED_SINCE_PROBE`). 거부한 기록은 `mutation-journal.rejected-*.json`으로 옮겨 검증을 막지 않는다. 복구했거나 거부한 사실은 증거 매니페스트의 `probe_recovery`와 검토 보고서의 위험 항목에 남는다.
- 문자열과 주석 제외: 파서 없이 토큰 단위로 치환하되, 먼저 그 줄의 문자열 리터럴 내용과 줄 끝 주석을 가린 뒤 연산자를 찾는다. 주석 문법은 확장자로 정한다(`//`·`/* */` 계열, `#` 계열). `'`가 문자 하나를 뜻하는 언어(Go·Rust·Java·C 계열 등)에서는 `'x'` 형태만 문자열로 보고 Rust 수명 표기(`'a`)는 코드로 둔다. 변이는 계획 단계에서 찾은 열에만 적용하므로, 같은 줄의 문자열 안에 같은 연산자가 앞서 있어도 그쪽을 바꾸지 않는다.
- 한계: 줄 단위로만 판단한다. 여러 줄에 걸친 문자열·템플릿 리터럴·블록 주석의 중간 줄과 정규식 리터럴은 코드로 취급된다. 확장자를 모르는 파일은 주석을 가리지 않는다. 의미가 같은 변이(동치 변이)도 생길 수 있어 생존 변이는 사람이 확인할 후보이지 결함 확정이 아니다.
- 문장 삭제(`line_delete`): 연산자가 없는 줄은 문장 하나를 통째로 없앤다. JS/TS는 `;`로 끝나고 괄호가 그 줄 안에서 닫히는 줄을 비우고, Python은 블록 머리·데코레이터·독스트링·이어지는 줄이 아닌 문장을 `pass`로 바꾼다. `export` 문과 문자열만 있는 문장은 건드리지 않는다. 다른 언어에는 적용하지 않는다. 컴파일 언어에서 `return`을 지우면 빌드가 깨지는데, 그러면 어떤 테스트도 그 줄에 닿지 않았어도 제거로 집계되기 때문이다. 세미콜론을 쓰지 않는 JS 코드는 삭제 대상이 되지 않는다. 변이 상한에 걸리면 연산자 변이를 먼저 쓴다.

### 13. 경량 프로필의 E2E 조건부 면제 (`scripts/lib/lite-profile.mjs`, `process_profile: "lite"`)

작은 버그 수정에 한해 V01의 E2E 요구를 면제한다. 면제는 선언만으로 주어지지 않고, `verify`가 실제 diff로 아래 조건을 매번 다시 확인한다.

| 조건 | 기본값 | 계약에서 조정 |
|---|---|---|
| `change_kind` | `bugfix`만 허용 | 불가 |
| 변경된 소스 파일 수 | 3개 이하 | `verification_policy.lite_max_changed_source_files` (1~10) |
| 소스에 추가된 줄 수 | 60줄 이하 | `verification_policy.lite_max_added_lines` (1~300) |
| 증거 강도 | `weak`가 아닐 것 | 불가 |

- 조건을 모두 만족하고 E2E 검사가 계약에 없으면 면제한다. 면제된 E2E는 통과로 치지 않고 미검증 항목으로 남기므로 `technical_status`는 `PARTIAL`이 되고, 검토 보고서 1절과 6절에 면제 사실이 표시된다.
- 조건을 하나라도 벗어나면 `LITE_PROFILE_EXCEEDED`로 실패한다. E2E 검사를 추가하거나 전체 프로필로 재계획해야 한다.
- 증거 강도 조건 때문에 범용 테스트 명령 하나만 있는 계약(`SINGLE_GENERIC_CHECK`)이나 변경 코드에 닿는 테스트가 없는 변경(`NO_TEST_REACHES_CHANGE`)은 면제를 받지 못한다.
- E2E 없는 경량 계약에 범용 `kind: "test"` 명령만 있으면 계약 준비 판정이 `LITE_TARGETED_TEST_MISSING`으로 막는다. 승인 전에 `contract add-test <계약> --test-cmd "<명령>"`이나 `start --test-cmd`로 이번 변경을 직접 검사하는 테스트(`kind: "unit"`)를 넣는다. 전용 테스트로 인정하는 것은 실행되는 종류(`unit`, `fast`, `property`, `differential`)이면서 범용 명령과 다른 명령뿐이다. `manual` 검사나 범용 명령을 종류만 바꿔 다시 넣은 것은 인정하지 않고, `add-test`는 범용 명령과 같은 명령을 거부한다.
- 추가 줄 수는 아직 `git add`하지 않은 새 파일도 같은 방식으로 센다. 미추적 파일도 헌크 헤더가 있는 diff로 만들어, 스테이징 전후로 판정이 같다. 바이너리 파일(앞 8000바이트에 NUL 바이트가 있는 파일)은 git처럼 줄 없이 `Binary files ... differ`로 표시한다.
- 한도는 승인된 계약에 들어 있어 실행 중에 바꾸면 계약 해시 불일치로 걸린다.
- 한도 보정 (`scripts/calibrate.mjs`, `calibrate lite`): 기본 한도(소스 3개, 60줄)는 데이터 없이 정한 초기값이다. 근거를 쌓기 위해 `verify`는 호출할 때마다 `evidence/profile-observations.jsonl`에 한 줄을 덧붙인다. 증거 매니페스트는 다음 라운드에 덮어써지므로, 단위 검사는 통과했는데 E2E가 실패한 라운드는 이 로그에만 남는다. `calibrate lite --repo <path>...`는 여러 저장소의 로그를 모아 후보 한도마다 다음을 보고한다.
  - 정보가 되는 라운드: E2E를 실행했고, 나머지 검사가 모두 통과했고, 증거 강도가 `weak`가 아닌 버그 수정 라운드
  - 표본 단위: 라운드가 아니라 실행이다. 경량 실행은 나머지 검사가 처음 모두 통과한 라운드에서 멈추므로, 실행마다 한도 안의 첫 정보 라운드 하나만 센다. 같은 작업을 여러 번 다시 검증해도 독립된 판단은 하나다.
  - E2E가 잡아낸 수: 그 라운드에서 E2E가 실패한 실행. 같은 크기의 경량 실행이었다면 놓쳤을 결함이다.
  - 놓침 비율의 95% 상한: 잡아낸 것이 0이면 약 3/n(3의 규칙, n은 실행 수)
  - 적용 범위: 버그 수정 실행 중 그 한도 안에 드는 비율
- 판정은 `INSUFFICIENT_DATA`(기본 한도 안의 표본 실행이 `--min-samples`, 기본 20개 미만. 1 이상의 정수만 받는다), `DEFAULT_SUPPORTED`, `DEFAULT_TOO_LOOSE`(기본 한도 안에서 E2E가 잡아낸 실행이 있음) 중 하나다. 표본이 충분하고 잡아낸 것이 없는 후보 중 가장 넓은 것을 `suggested_limits`로 보여 주지만 자동으로 적용하지 않는다. 바꾸려면 계약의 `verification_policy`에 직접 적는다.
- 한계: 경량 실행은 E2E를 건너뛰므로 놓침에 대한 정보를 주지 않는다. 근거는 E2E 검사를 둔 전체 프로필 버그 수정 실행에서만 나온다. 이 저장소에는 아직 그런 기록이 없어 기본 한도는 여전히 근거 없는 초기값이다.
- 뮤테이션 검사를 켰다면 증거 강도는 검사 결과를 반영한 등급으로 판정한다. 변이가 절반 넘게 살아남아 등급이 `weak`가 되면 면제를 받지 못하고 `LITE_PROFILE_EXCEEDED`(`MUTANTS_SURVIVED`)로 실패한다. 생존 변이가 절반 이하라 등급이 `moderate`이면 면제는 유지되고 보고서의 증거 강도 신호로 드러난다.
- 한계: 뮤테이션 검사는 기본으로 꺼져 있다. 경량 계약이 검사를 켜지 않으면 증거 강도는 정적 도달 여부로만 판정된다.

### 14. 증거 로그의 기록과 대조 (`scripts/lib/evidence-io.mjs`)

검사 명령의 표준 출력과 표준 오류는 에이전트가 아니라 `verify`가 실행 디렉터리에 쓴다. 증거 매니페스트의 검사 항목마다 실행 명령, 종료 코드, 시작 시각(`started_at`), 소요 시간과 함께 저장한 로그의 SHA-256(`stdout_sha256`, `stderr_sha256`)을 남긴다.

- `review-package`와 `approve record`는 로그를 다시 해시해 매니페스트와 대조하고, 로그가 없거나 다르면 `EVIDENCE_LOG_ALTERED`로 멈춘다. 승인 뒤에도 같은 대조를 한다. `approve verify`는 로그가 바뀌면 결정을 `INVALIDATED`로 보고하고, `checkpoint resume`은 `READY_FOR_HUMAN_REVIEW`나 `ACCEPTED` 상태를 복원하지 않는다(`STALE_ARTIFACTS_CANNOT_RESTORE`). `resume`은 `ACCEPTED`를 복원할 때 서명과 보호된 승인자 정책도 다시 확인한다. `verify`를 다시 실행하면 로그와 해시가 새로 쓰인다.
- 저장 전에 시크릿으로 보이는 값을 `[REDACTED:<이름>]`으로 가린다. 대상은 이름에 `TOKEN`·`SECRET`·`PASSWORD`·`API_KEY`·`PRIVATE_KEY`·`ACCESS_KEY`·`CREDENTIAL`이 들어간 환경 변수의 값(8자 이상)과, 형태가 알려진 토큰(PEM 개인 키, Anthropic·GitHub·AWS·Slack 토큰)이다. 가린 횟수는 검사 항목의 `redactions`에 남는다. 종료 코드 판정, differential 비교, property 반례 추출은 가리기 전 출력으로 한다.
- 체크포인트, 증거 매니페스트, 검증 스탬프, 승인 레코드는 임시 파일에 쓴 뒤 이름을 바꾸는 방식으로 저장해, 쓰는 도중 프로세스가 죽어도 반쯤 쓰인 파일이 남지 않는다.
- 한계: 매니페스트도 로그와 같은 실행 디렉터리에 있어 작업 공간에 쓸 수 있는 주체는 둘을 함께 고칠 수 있다. 이 대조가 잡는 것은 로그만 고친 경우다. 가림은 위 두 부류에 드는 값만 잡는다. 인수 검사와 신뢰성 규칙 명령의 출력에만 적용하고 `evidence/changes.patch`에는 적용하지 않는다.

### 15. 범위 glob 문법 (`scripts/lib/paths.mjs`)

`scope.allow`·`scope.protect`와 테스트 파일 패턴은 `**`(깊이 무관), `*`(한 경로 구간 안), `?`(한 글자), 끝의 `/`(그 디렉터리 아래 전부)만 해석한다. 그 밖의 문자는 `[]`를 포함해 글자 그대로 비교한다. `src`처럼 디렉터리 이름만 쓰면 그 경로 하나만 뜻한다.

- 부정(`!pattern`)과 중괄호 선택(`{a,b}`)은 지원하지 않는다. 글자 그대로 비교되어 어떤 파일과도 맞지 않으므로, `scope.protect`에 쓰면 아무것도 보호하지 못한다. 계약 준비 판정이 이런 패턴을 `SCOPE_GLOB_UNSUPPORTED`로 알리고, 선택지는 패턴을 하나씩 나눠 적어야 한다.

### 16. 검증 회차 기록과 실패 원인 보기 (`scripts/lib/verify-history.mjs`, `scripts/lib/explain-run.mjs`)

`verify`는 호출할 때마다 증거 매니페스트와 검사 로그를 덮어쓰므로, 수정이 들어간 뒤에는 그 전에 무엇이 실패했는지 남지 않는다. 그래서 회차마다 `evidence/verify-history.jsonl`에 한 줄을 덧붙이고(스냅샷 해시, 판정, 검사별 상태·종료 코드·사유·로그 해시), 그 회차에 실패한 검사의 출력만 `evidence/history/round-NNN/`에 복사해 둔다. 통과한 검사의 출력은 복사하지 않는다.

- `verify --history [--json]`은 기록을 읽어 보여 주기만 하고 아무것도 실행하지 않는다. 같은 스냅샷에서 같은 결과로 연달아 돌린 회차는 한 번의 시도로 묶는다. 시도 사이에서는 검사를 고쳐짐(FAIL → PASS), 새로 실패(PASS → FAIL), 계속 실패, 이번에 처음 실행, 이번에는 실행 안 됨으로 나눈다. 스냅샷이 같은데 결과가 달라진 시도는 코드는 그대로라고 표시한다. 흔들리는 테스트일 수 있다.
- `status --explain [--run-id <id>] [--json]`은 마지막 검증에서 실패한 검사마다 실행한 명령, 종료 코드와 기대값, 판정 사유, 로그 경로, 출력의 끝 12줄을 보여 준다. 검사 밖의 실패 사유(범위 위반, E2E 누락 등), 원인별 복구 횟수와 남은 횟수, 직전 시도 대비 변화, 증거 강도 신호가 요구하는 사람 확인 항목도 함께 나온다. 실행 하나를 대상으로 하므로, 진행 중인 실행이 여럿이면 `--run-id`가 필요하다.
- 두 명령 모두 `verify`가 이미 저장한 파일만 읽는다. 피드백 패킷은 같은 회차의 매니페스트가 가리킬 때만 쓴다. 통과한 뒤에도 이전 실패의 패킷 파일이 남아 있기 때문이다.
- 한계: 기록은 실행 디렉터리에 있어 사람이 읽는 자료이지 통제 수단이 아니다. 범위 가드가 파일 도구의 쓰기는 막지만, 디렉터리에 쓸 수 있는 주체는 고칠 수 있다. 이 기능이 들어가기 전의 회차는 기록에 없다. 보관에는 상한이 없으며, 회차 수는 복구 한도(원인당 3회)로 사실상 제한된다.

### 17. 검사 명령의 시간 제한 (`scripts/lib/exec.mjs`, `scripts/verify.mjs`)

- 수용 기준 명령의 제한 시간은 그 항목의 `timeout_ms`, 없으면 계약의 `verification_policy.check_timeout_ms`, 그것도 없으면 10분이다. `contract add-e2e`와 `add-test`는 `--timeout-ms`로 항목에 값을 넣는다. 신뢰성 규칙 명령에는 계약 단위 값이 적용된다.
- 제한 시간에 걸린 명령은 종료 코드 124로 기록한다. 127(명령 없음)과 섞이지 않게 하려는 것이다. 매니페스트의 검사 항목에는 `timed_out: true`와 적용된 `timeout_ms`가 남고, 사유는 "Timed out"으로 시작하며, 표준 오류 로그 끝에 중단 사실을 적는다.
- 실패 사유는 `AC_FAILED`가 아니라 `AC_TIMEOUT`이다. 실패한 검사가 모두 시간 초과이면 수리 원인이 `CHECK_TIMEOUT`으로 분류되어 테스트 실패나 E2E 실패의 수리 횟수를 쓰지 않는다. 시간 초과는 변경이 틀렸다는 증거가 아니기 때문이다. 다만 통과도 아니므로 `technical_status`는 `FAILED`다.
- RED 기록(`verify --record-red`)에서 명령이 시간 초과되면 `RED_TIMEOUT`으로 거부한다. 끝나지 않은 명령은 기능이 없어서 실패한 것으로 볼 수 없다.
- 뮤테이션 검사는 각 명령을 `verify`에서 통과할 때와 같은 제한 시간으로 다시 실행한다.
- `verify`가 도는 동안 파일을 고치면 증거가 시작 시점의 스냅샷에 묶인 채로 트리만 달라진다. 이 상태는 `review-package`와 `approve record`가 현재 스냅샷을 다시 계산해 `STALE`로 거부하므로 승인까지 가지 않는다. `verify`를 다시 실행하면 풀린다.

### 18. 요구사항별 검증 범위와 단계별 소요 시간 (`scripts/verify.mjs`, `scripts/review-package.mjs`)

- 계약의 `requirements` 가운데 적용되는 수용 기준이 하나도 가리키지 않는 요구는 검증된 것이 아니다. `contract validate`와 `approve`는 `REQUIREMENT_WITHOUT_ACCEPTANCE` 경고를 내고, `verify`는 그 요구를 미검증 항목에 넣어 `technical_status`를 `VERIFIED`가 아닌 `PARTIAL`로 둔다.
- 검토 보고서 3절은 수용 기준마다 요구 ID와 요구 문구를 함께 보여 주고, 수용 기준이 없는 요구는 `UNVERIFIED` 행으로 따로 싣는다. 1절의 "승인하면 달라지는 것"에도 검증되지 않은 요구 ID를 적는다.
- `requirements`가 없는 예전 계약에는 이 검사가 적용되지 않는다.
- `verify`는 단계(작업 트리 스냅샷, 범위와 diff, 영향도 분석, 수용 기준 실행, 신뢰성 규칙과 리뷰, 뮤테이션 검사, 증거 기록)마다 걸린 시간을 표준 오류에 출력하고 결과의 `stage_times_ms`에 싣는다.
- 매니페스트의 `process_profile.limits_enforced`는 크기 한도가 실제로 적용되는지를 뜻한다. 한도는 경량 프로필의 E2E 면제를 판정할 때만 쓰이므로 전체 프로필에서는 `false`이고, 관측값이 한도를 넘어도 `violations`는 비어 있다.
- 선택적 회귀(`--selective`)에서도 대상 파일을 알 수 없는 포괄 명령(`pytest -q` 등)은 안전을 위해 실행한다. 건너뛰게 하려면 그 수용 기준에 `target_files`를 적어 영향 범위와 대조할 수 있게 한다.

### 19. 스냅샷의 범위 (`scripts/lib/git.mjs`의 `computeSnapshotDigest`)

- git 저장소에서 `target_snapshot_digest`는 git이 보는 트리, 곧 추적 파일과 무시되지 않은 미추적 파일로 계산한다. `verify`가 범위와 diff를 git으로 읽으므로 판정 대상과 스냅샷 대상이 같아진다.
- git이 무시하는 파일(빌드 산출물, 가상 환경 등)은 스냅샷에 들어가지 않는다. 이런 디렉터리에 파일이 십만 개 넘게 쌓인 저장소에서 `verify`, `replan`, `status`가 매번 수 분씩 걸리던 원인이었다.
- 그 결과 검증 뒤 승인 전에 무시 파일이 바뀌어도 `STALE`이 되지 않는다. 바뀌면 안 되는 경로는 git이 무시하더라도 계약의 `scope.protect`에 적는다. 보호 경로는 실행을 열 때 따로 해시하고 `verify`와 `checkpoint resume`에서 대조한다.
- git 저장소가 아닌 디렉터리에서는 전과 같이 모든 파일을 훑는다. `.crafthelm/runs/`, `.git/`, `node_modules/`는 어느 경우에도 제외한다.
- 이 변경 전에 계산한 스냅샷 값은 무시 파일이 있던 저장소에서 지금 값과 다르다. 진행 중이거나 승인 대기 중인 실행은 `verify`를 다시 실행해야 한다.

### 20. 스킬 사본의 관리 표시와 실행 초기화 순서 (`scripts/install-skills.mjs`, `scripts/init-host.mjs`, `scripts/checkpoint.mjs`)

- `init-host`가 대상 저장소에 쓰는 스킬 사본(`.claude/skills/crafthelm` 등)에도 `install-skills`와 같은 설치 매니페스트(`.crafthelm-skill-install.json`)를 남긴다. 매니페스트가 있는 사본은 `install-skills --scope project`와 `init-host` 재실행이 `--force` 없이 갱신한다.
- 매니페스트가 없는 사본은 사용자가 직접 둔 것일 수 있으므로 전과 같이 건드리지 않는다(`SKIPPED_UNMANAGED`). 매니페스트를 남기기 전의 `init-host`가 만든 사본이 이 상태다. `--force`로 한 번 덮어쓰면 그 뒤로는 관리 대상이 된다.
- `doctor`는 매니페스트가 없고 내용이 현재 체크아웃과 다른 사본을 `CLAUDE_SKILL_UNMANAGED`로 경고한다. 프로젝트 사본은 사용자 범위 사본 대신 읽히므로, 사용자 범위만 갱신하면 에이전트는 예전 절차를 읽는다. `doctor`가 내는 수정 명령은 대상 저장소에서 그대로 실행할 수 있는 디스패처 경로다.
- 여러 호스트가 함께 쓰는 `.agents/skills/crafthelm`은 처음 쓴 호스트 프로필을 매니페스트에 적어 두고, 이후 갱신과 상태 점검은 그 프로필을 기준으로 한다. 프로필을 바꾸려면 `--force`를 쓴다.
- 실행 폴더(`approvals/`, `evidence/`, `reports/`)는 기준선 해시 계산이 끝난 뒤 `checkpoint.json`과 함께 만든다. 계산 도중 명령이 중단되어도 체크포인트 없는 실행 폴더가 남지 않는다.
- `contract approve --init-run`이 승인을 기록한 뒤 실행을 열기 전에 중단되면 승인만 남는다. 같은 명령을 다시 실행하면 승인은 그대로 두고 실행만 연다. 이때 알림은 "아무것도 쓰지 않았다"가 아니라 실행을 열었다고 적는다.

### 21. 대기 중인 실행을 한 번에 결정하기와 수용 없이 닫기 (`scripts/approval.mjs`, `scripts/checkpoint.mjs`)

- `approve batch --repo <path> --actor <이름>`은 사람 결정을 기다리는 실행을 모두 나열하고, 실행마다 지금 상태로 수용할 수 있는지를 보여 준 뒤, 수용할 실행과 수용 없이 닫을 실행을 묻는다. 수용은 고른 실행 전체에 대해 확인 코드를 한 번 입력한다. 실행마다 결정 기록(`approvals/decision.json`)이 따로 남고, 둘 이상을 함께 수용한 기록에는 `batch.run_ids`가 들어간다.
- `approve batch`는 `approve record`와 같은 관문을 지난다. AI 에이전트 세션 안에서는 실행되지 않고, 항상 터미널이 필요하며, Claude Code 권한 규칙에서 거부(deny) 대상이다. `--sign-key`를 주면 기록에 서명한다.
- `approve queue --repo <path>`는 같은 목록을 JSON으로 출력하고 아무것도 바꾸지 않는다.
- 수용할 수 없는 실행(보고서·계약·증거가 검증 때와 다른 실행)은 사유와 함께 표시된다. 검증한 뒤 작업 트리가 달라진 것은 25절부터 수용을 막지 않는다.
- `checkpoint close --repo <path> --run-id <id>[,<id>...] --reason "<사유>" [--superseded-by <run-id>]`는 실행을 수용 없이 끝낸다. 상태는 `ABORTED`가 되고 체크포인트의 `closure`에 사유, 닫기 전 상태, 닫은 경로(`agent_session`, `interactive_terminal`, `non_interactive`)가 남는다. 결정 기록은 만들지 않으며 증거는 그대로 둔다. 여러 실행을 줄 때는 모두 닫을 수 있어야 닫는다.
- 닫기는 수용이 아니므로 에이전트 세션에서도 실행할 수 있다. Claude Code에서는 권한 규칙이 사용자에게 확인을 묻는다(ask). 이미 결정이 기록된 실행(`ACCEPTED`, `REJECTED` 등)은 닫을 수 없다.
- `approve` 명령은 사람이 검토 보고서를 읽으며 답하는 동안 기다리므로 디스패처의 명령 시간 제한을 적용하지 않는다.

### 22. 여러 실행이 함께 있을 때의 범위와 선택적 회귀 (`scripts/lib/scope-guard.mjs`, `scripts/verify.mjs`, `scripts/lib/impact-analysis.mjs`)

- 범위 가드는 지금 작업 중인 실행의 범위만 적용한다. 사람 결정을 기다리는 실행(`READY_FOR_HUMAN_REVIEW`, `BLOCKED_HUMAN_ATTENTION`, `BLOCKED`, `REPLAN_REQUIRED`)의 `scope.protect`는 작업 중인 실행이 있을 때 쓰기를 막지 않는다. 작업 중인 실행이 여럿이면 작성 잠금을 가진 실행의 범위를 적용하고, 잠금이 없으면 전과 같이 합쳐 적용한다. 작업 중인 실행이 하나도 없으면 대기 중인 실행의 범위가 그대로 적용된다.
- 대기 중인 실행이 보호하던 경로를 다른 실행이 고치면 그 실행의 스냅샷은 달라진다. 수용하려면 다시 검증해야 하고, 그때 보호 경로 변경이 `PROTECTED_PATH_VIOLATION`으로 보고된다. 가드가 막지 않을 뿐 `verify`의 판정은 바뀌지 않았다.
- 선택적 회귀에서 검사를 건너뛴다는 것은 앞선 통과 결과를 그대로 쓴다는 뜻이다. 이 실행에서 같은 명령으로 통과한 기록(검증 이력이나 `--record-baseline-green`)이 없는 검사는 건너뛰지 않고 실행하며, 선택 사유는 `no_earlier_pass_in_this_run`이다. 그러지 않으면 한 번도 실행되지 않은 검사가 유일한 수용 기준인 요구가 `VERIFIED`로 보고된다.
- 영향도 분석이 읽지 못하는 데이터 파일(`.json`, `.jsonc`, `.json5`, `.jsonl`, `.xml`, `.xsd`, `.avsc`)이 바뀌면 전체 실행으로 대체한다(`UNPARSED_SOURCE_CHANGED`). 스키마나 설정을 읽는 테스트와 그 파일을 정적으로 연결할 수 없기 때문이다.
- `verify`의 변경 파일은 실행의 기준선부터 지금 트리까지다. 그사이 다른 계약으로 진행한 작업도 여기에 잡히며, 이 실행의 범위 밖이면 `SCOPE_VIOLATION`이다. 다른 실행의 범위는 어떤 경로도 면제하지 않는다. 대신 `SCOPE_VIOLATION` 다음 줄에 `SCOPE_NOTE`로 그 파일이 어느 실행의 범위 안인지를 적는다. `SCOPE_VIOLATION` 줄 자체는 파일 목록만 담는다. 한 실행을 결정하기 전에 다음 실행을 시작하면 앞선 실행은 이 트리에서 다시 통과할 수 없다.

### 23. 실행 도중 재설치로 추가된 권한 규칙 (`scripts/verify.mjs`, `scripts/lib/claude-hooks.mjs`)

- 실행 도중 CraftHelm을 다시 설치하면 새 명령의 권한 규칙과 훅이 `.claude/settings.json`에 추가된다. 기준선과의 차이가 CraftHelm 가드의 추가뿐이면 `verify`는 이 파일을 실행의 변경으로 세지 않는다. 스킬 사본을 그대로 재설치한 경우와 같은 취급이다.
- 가드는 `hosts/claude/settings.example.json`에 적힌 그대로의 규칙과, 이 체크아웃이 등록하는 그대로의 훅 항목만 인정한다. 추가만 면제한다. 기준선에 있던 가드가 빠졌거나, 다른 규칙이나 키가 달라졌거나, 가드 스크립트 이름만 포함한 다른 명령이 들어가면 전과 같이 `SCOPE_VIOLATION`이다.
- 비교하려면 기준선 내용이 필요하다. 기준선 커밋에 `.claude/settings.json`이 들어 있고 그 해시가 체크포인트에 동결된 값과 같을 때만 면제한다. 커밋된 적이 없거나 `checkpoint rebaseline`으로 기준선을 옮긴 뒤에는 면제하지 않는다. 계약이 이 파일을 `scope.protect`에 넣었을 때도 면제하지 않는다.
- 범위 밖 변경이 모두 도구 파일(`checkpoint rebaseline`이 다루는 파일)일 때는 `SCOPE_VIOLATION` 다음 줄에 `SCOPE_NOTE`로 그 사실과 `checkpoint rebaseline` 명령을 적는다. 과제가 만든 변경이 아니라 도구를 갱신해서 생긴 차이임을 구분하기 위해서다.

### 24. 검토 화면 (`scripts/review.mjs`, `scripts/lib/review-page.html`)

- `review --repo <path>`는 사람 결정을 기다리는 실행을 브라우저 한 화면에 보여 준다. 과제 이름의 앞부분(`TR-M1B-GLOSS`는 `TR-M1B`)으로 묶고, 실행마다 요청, 변경 규모, 요구별 검사와 결과, 검증되지 않은 것, 바뀐 파일을 차례로 보여 준다. 변경 내용과 검사 로그는 그 자리에서 펼쳐 본다.
- 결정도 그 화면에서 한다. 수용(여러 건을 골라 한 번에 가능), 수정 요청, 수용 없이 닫기다. 실행마다 결정 기록이 따로 남고 `verification_type`은 `local_review_page_not_identity_verified`다. 터미널에서 해시를 입력하는 확인은 이 경로에 없다. 이 유형도 다른 두 유형과 같이 결정을 어떻게 입력했는지를 뜻하며, 누가 입력했는지를 증명하지 않는다.
- 수정 요청에 적은 의견은 결정 기록의 `rationale`이 되고, 실행은 `CHANGES_REQUESTED`가 된다. 다음 턴의 세션 알림이 그 의견을 그대로 싣는다. 검토자의 말이 에이전트의 다음 작업 지시가 된다.
- 수용 조건은 `approve record`와 같다(25절). 검증 뒤 트리가 달라진 실행은 그 사실과 이후 달라진 파일을 알림으로 보여 주고 수용할 수 있다. 여러 건을 함께 수용할 때 하나라도 수용할 수 없으면 아무것도 기록하지 않는다.
- 관문: 명령은 `approve record`와 같이 AI 에이전트 세션 안에서는 시작되지 않고 터미널이 필요하다. 서버는 `127.0.0.1`에서만 듣고, 모든 경로는 그 프로세스가 만든 일회용 토큰으로 시작하며, 결정 요청은 그 페이지에서 온 것(`Origin`)만 받는다. 토큰이 든 주소는 브라우저를 열지 못했을 때만 터미널에 출력한다. 같은 컴퓨터에서 그 주소를 알아낸 프로세스는 결정을 기록할 수 있으므로, 이 관문의 강도는 터미널 확인과 같은 수준이다.
- 화면에 나오는 변경 내용과 줄 수는 `verify`가 이 실행의 변경으로 센 파일에 한한다. 저장된 patch에는 계약과 과제 문서도 들어 있다.

### 25. 수용은 검증된 스냅샷에 대한 것이다 (`scripts/approval.mjs`, `scripts/checkpoint.mjs`, `scripts/verify.mjs`)

이 절은 "검토 보고서를 만든 뒤 코드 스냅샷이 달라지면 수용을 막고, 수용 뒤 달라지면 수용을 무효로 본다"는 이전 규칙(H03, E14의 스냅샷 부분)을 바꾼다.

- 이전 규칙에서는 한 실행을 결정하기 전에 다음 작업을 시작하면 앞선 실행을 수용할 수 없었다. 다시 검증하려 해도 이후 작업의 파일이 범위 위반으로 잡혀 통과하지 못했고, 남은 길은 닫는 것뿐이었다.
- 사람의 결정은 검증된 것에 대한 것이다. 검증 스탬프의 스냅샷, 검토 보고서, 검사 로그가 해시로 묶여 있고, 결정 기록의 `target_snapshot_digest`는 결정 시점의 트리가 아니라 그 검증된 스냅샷이다.
- 검증 뒤 트리가 달라졌어도 수용할 수 있다. 그때 결정 기록에 `tree_at_decision_digest`(결정 시점의 트리)와 `changed_since_verification`(이 실행이 바꾼 파일 가운데 검증 때와 달라진 것)이 남는다. 검토 화면, `approve batch`, `approve queue`가 같은 내용을 결정 전에 보여 준다.
- `verify`는 변경 파일마다 검증 당시의 해시를 매니페스트의 `scope.changed_file_hashes`에 적는다. 이 기록이 없는 예전 실행은 "트리가 달라졌다"는 사실만 알 수 있고 `changed_since_verification`은 남지 않는다.
- 수용을 막는 것은 그대로다. 보고서가 검증 뒤 수정됐거나(`STALE_REPORT`), 계약이 바뀌었거나(`CONTRACT_MISMATCH`), 검사 로그가 달라졌거나(`EVIDENCE_LOG_ALTERED`), 검증을 다시 실행하고 보고서를 다시 발행하지 않아 스탬프와 체크포인트의 스냅샷이 다를 때(`STALE_SNAPSHOT`)다.
- `approve verify`는 트리가 달라졌다는 이유로 결정을 무효로 보지 않는다. 결과의 `tree_matches_decision`이 지금 트리가 그 스냅샷인지를 알려 준다. 보고서, 매니페스트, 로그, 서명이 달라지면 전과 같이 `INVALIDATED`다.
- `checkpoint resume`도 트리가 달라졌다는 이유만으로 `READY_FOR_HUMAN_REVIEW`나 `ACCEPTED`를 `VERIFYING`으로 되돌리지 않는다. 보고서나 증거가 달라졌으면 전과 같이 되돌린다.
- 달라지지 않는 것: 검토 보고서는 검증 직후의 트리에서만 발행된다. 수용된 실행이 지금 코드 그대로라는 보장은 수용 기록이 아니라 `tree_matches_decision`과 `changed_since_verification`으로 확인한다.

### 26. 승인된 계약의 사본과 대조 (`scripts/lib/contract-approval.mjs`, `scripts/contract.mjs`, `scripts/checkpoint.mjs`)

- 계약 승인은 계약 파일 안의 표시(`approval.contract_approved`)였다. 파일을 직접 고쳐도 표시는 남으므로, 승인 뒤 수용 기준을 지우거나 검사 명령을 바꾸거나 수정 범위를 넓힌 계약이 승인된 계약으로 읽혔고 그 위에 실행을 열 수 있었다. 같은 사람이 다시 승인하면 내용을 대조하지 않고 "이미 승인됨"이라고 답했다.
- 승인할 때 계약 본문과 그 해시를 계약 파일 밖(`.crafthelm/runs/.approvals/<task>.json`)에 남긴다. 비교 대상은 누가 언제 승인했는지를 뺀 본문 전체다. `interview`나 `start`가 `--approve-contract`로 승인 상태의 계약을 쓸 때도 같이 남긴다.
- 승인에 기대는 곳마다 지금 계약을 그 사본과 대조한다. `checkpoint init`(`contract approve --init-run` 포함)과 `checkpoint replan`은 다르면 `CONTRACT_CHANGED_SINCE_APPROVAL`로 멈추고 무엇이 달라졌는지 적는다. 승인 표시는 있는데 사본이 없으면 `CONTRACT_APPROVAL_RECORD_MISSING`으로 멈춘다. 이 변경 전에 승인하고 아직 실행을 열지 않은 계약이 이 경우이며, 한 번 다시 승인하면 된다.
- 승인 표시가 있는데 사본과 다른 계약을 다시 승인하려면 `--accept-changes`가 필요하다. 없으면 거부하고 차이를 보여 준다. `contract add-e2e`와 `add-test`처럼 표시를 지우는 정식 경로로 고친 계약은 그냥 승인되고, 직전 사본과의 차이가 알림으로 나온다.
- `contract diff <계약>`은 지금 계약과 승인된 사본의 차이를 보여 준다. "덜 요구하거나 더 허용하는" 변경(수용 기준 삭제, 검사 명령·종류·기대 종료 코드 변경, 적용 제외, `scope.allow` 확대, `scope.protect` 해제, 요구 삭제, 검증 정책·예산 변경)을 나머지와 구분한다.
- 실행을 연 뒤의 변경은 전과 같이 체크포인트의 `contract_sha256`이 잡는다. 이 절이 막는 것은 승인과 실행 시작 사이, 그리고 재계획 때다.
- 한계: 사본은 대조할 기록이지 잠금이 아니다. 그 폴더는 스냅샷에서 빠지고 범위 가드가 파일 도구의 쓰기를 막지만, 셸로 쓸 수 있는 프로세스는 사본도 고칠 수 있다. 그 폴더는 git이 무시하므로 저장소를 새로 받은 곳에는 사본이 없고, 실행을 열기 전에 다시 승인해야 한다. `.crafthelm/contracts/` 밖에 있는 계약 파일은 어느 저장소의 것인지 알 수 없어 사본을 남기지 않는다.

### 27. 프로젝트의 구역: 엄격 구역과 가벼운 구역 (`scripts/lib/zones.mjs`, `scripts/zones.mjs`)

- CraftHelm은 모든 변경에 같은 무게의 절차를 적용했다. 문구 하나를 고치는 일과 다른 도구가 읽는 스키마를 바꾸는 일이 같은 단계를 거쳤다. 어디서 실수가 비싼지는 프로젝트가 안다.
- 프로젝트는 그 답을 `.crafthelm/zones.json`에 적는다. `strict`에 적힌 경로가 엄격 구역이고, 경로마다 그 이유를 함께 적는다. 나머지는 가벼운 구역이다. 엄격 구역이 없다고 정할 수도 있다(`--none`). 아직 정하지 않은 상태는 "전부 가벼움"이 아니라 "미정"이라는 세 번째 상태다.
- CraftHelm은 이 정의와 그것을 읽는 기능만 제공하고, 경로 목록은 두지 않는다. 구역은 프로젝트를 시작할 때 설계와 인터뷰를 거쳐 그 프로젝트가 정한다.
- 정하는 명령은 `zones set --actor <이름> --strict "<경로>::<이유>"`이다. 누가 어떤 경로로 정했는지가 함께 기록된다. Claude Code에서는 실행 전에 사용자에게 확인을 묻는다. `zones show`는 지금 상태(미정, 커밋 전, 커밋된 것과 다름, 커밋됨)를, `zones check --files`는 파일들이 어느 구역인지를 보여 준다.
- 실행에 적용되는 구역은 작업 사본이 아니라 그 실행의 보호 기준 참조에 커밋된 파일이다. 승인자 정책과 같은 방식이다. 실행 도중 구역 파일을 고쳐도 그 실행의 구역은 달라지지 않고, 그 수정은 범위 밖 변경으로 보고된다. 범위 가드는 이 파일을 파일 도구로 쓰지 못하게 막는다.
- `verify`는 실행의 변경 파일이 어느 구역에 속하는지를 매니페스트의 `zone`에 적는다(`strict`, `light`, `undefined`, 그리고 엄격 구역에 속한 파일과 그 이유). 검토 화면이 실행마다 구역을 표시한다.
- 구역을 정하지 않은 프로젝트에는 `init-host`의 결과, 세션 시작 알림, `doctor`의 `ZONES_UNDEFINED` 경고가 그 사실과 정하는 명령을 알려 준다.
- 이 절은 구역을 정하고 보여 주는 데까지다. 구역에 따라 검토나 승인의 절차가 달라지는 것은 아직 없다.

### 28. 위임 수용의 수습 (`scripts/lib/acceptance-trial.mjs`)

- 목표는 가벼운 구역에서 깨끗하게 검증된 실행을, 사람이 미리 정한 규칙에 따라 한 건씩 읽지 않고 수용하는 것이다. 그 규칙을 켜기 전에 먼저 시험한다. 이 절은 시험까지이며, 규칙에 따라 수용되는 실행은 없다.
- 판정은 증거만으로 한다. 실행의 구역이 `light`이고, 자동 검증이 `VERIFIED`이고, 검증되지 않은 항목이 없고, 지금 상태로 수용할 수 있으면 "위임 대상"이다. 아니면 그 이유가 붙는다(`ZONE_STRICT`, `ZONE_UNDEFINED`, `NOT_VERIFIED`, `UNVERIFIED_ITEMS`, `NOT_ACCEPTABLE`). 구역을 정하지 않은 프로젝트에는 위임 대상이 없다.
- 검토 화면과 `approve queue`가 실행마다 이 판정을 보여 준다. 위임 대상이 아닌 실행에는 사람이 봐야 하는 이유가 함께 나온다.
- 사람이 결정할 때마다(수용, 수정 요청, 반려, 수용 없이 닫기) 그 결정과 규칙의 판정을 `.crafthelm/runs/.trial/acceptance-trial.jsonl`에 나란히 적는다.
- `approve trial --repo <path>`가 지금까지를 집계한다. 위임 대상 가운데 사람이 수용한 비율, 돌려보낸 실행의 목록, 위임 대상이 아닌 실행을 이유별로 센 수다. 한 번 돌려보낸 실행은 나중에 수용돼도 불일치로 센다. 닫힌 실행은 비율에 넣지 않는다. 결정된 위임 대상이 10건 미만이면 비율로 판단하기 이르다고 알린다.
- 한계: 실행의 변경 파일은 기준선부터 지금 트리까지다. 앞선 실행의 변경을 커밋하지 않고 다음 실행을 열면, 앞선 실행이 고친 엄격 구역의 파일이 다음 실행의 변경에도 잡혀 그 실행도 엄격 구역이 된다.
