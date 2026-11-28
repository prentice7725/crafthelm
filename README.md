# CraftHelm

CraftHelm은 단일 AI 호스트(Claude Code, Codex, Antigravity `agy`·IDE 세션, Gemini CLI, 또는 사용자 정의 CLI) 안에서 작업 계약, 결정적 검증, 사람의 최종 인수 절차를 강제하는 개발 운영 프레임워크입니다. 다른 AI 공급자 CLI나 외부 브로커를 부르지 않으며, 외부 npm 패키지 없이 Node.js 24 이상 내장 모듈(`node:sqlite`, `node:test`, `node:crypto`)만으로 동작합니다.

요구사항 정리와 코드 수정은 에이전트가 맡고, 테스트 실행·범위 검사·해시 기록은 로컬 스크립트가 맡습니다. 최종 인수 여부는 지정된 승인자가 결정합니다. 자동 검증이 통과해도 상태는 `READY_FOR_HUMAN_REVIEW`에서 멈추며, `COMPLETE` 상태는 없습니다.

호스트 스킬을 등록하면 세션 안의 에이전트가 `interview`, `route`, `delegate`, `verify`, `review-package` CLI를 순서대로 호출해 작업합니다. 계약 승인(`contract approve`)은 사용자가 대화에서 동의하면 에이전트가 실행할 수 있고, 최종 인수(`review`, `approve record`)와 키 생성(`approve keygen`)은 사람이 직접 실행합니다. 두 승인의 차이는 아래 [두 가지 승인](#두-가지-승인)에 있습니다.

## 작업 흐름과 구성

작업은 인터뷰와 계약 승인, 구현과 작업 분배, 실행 검증, 검토 보고서 발행, 사람 인수 다섯 단계로 이어집니다. 모든 산출물 구조는 `contracts/schemas/*.schema.json`에 정의된 14개 JSON Schema로 검증합니다.

1. **인터뷰와 계약 승인 (`start.mjs`, `interview.mjs`, `contract.mjs`):** 저장소 문서와 최근 Git 이력을 먼저 읽고, 요청 문구와 저장소 신호에서 질문을 만들어 `docs/tasks/<task_id>/interview_questions.md`에 남깁니다. `scope`, `acceptance`, `data`, `security`, `compatibility` 다섯 영역의 검토 여부도 함께 기록합니다. 기본적으로 미답변 질문은 가정으로 남겨 `CONTRACT_PENDING` 계약을 생성합니다. `--strict-interview`를 켜거나 입력 JSON에 미해결 `BLOCKER`가 있으면 계약을 쓰지 않고 `INTERVIEW_REQUIRED`를 돌려주며 멈춥니다. 이때는 `--scope-allow`·`--e2e-cmd`·`--test-cmd` 옵션을 채우거나 `interview --input <응답.json>`으로 답을 넘겨 다시 시작합니다. 계약의 기본 허용 범위(`scope.allow`)는 `['src/**', 'tests/**']`, 보호 경로(`scope.protect`)는 `tests/acceptance/**`, `docs/approved/**`, `REVIEW.md`, `.crafthelm/reliability-rules.json`입니다. 계약을 수정한 뒤에는 `contract approve`로 다시 승인받아야 합니다. 방법론은 `lifecycle`·`specification`·`engineering`·`execution` 네 설정 조합으로 12단계 계획을 생성합니다.
2. **구현과 작업 분배 (`checkpoint.mjs`, `route.mjs`, `delegate.mjs`, `memory.mjs`):** 에이전트는 허용 범위(`scope.allow`) 안에서 코드를 수정합니다. `route`는 작업을 `deterministic`·`lightweight`·`standard`·`reasoning` 네 단계로 분류해 `.crafthelm/config.json`의 `host_profiles`·`model_tiers`와 환경 변수(`CRAFTHELM_MODEL_LIGHTWEIGHT`, `CRAFTHELM_MODEL_STANDARD`, `CRAFTHELM_MODEL_REASONING`)에 맞는 모델 힌트를 고릅니다. `delegate run --execute`는 호스트 어댑터로 워커를 실행해 사용량을 실측하고, 세션 내 서브에이전트 결과는 `delegate record`로 받습니다. 위임 기록이 없으면 증거 매니페스트에 `UNOBSERVED`로 남깁니다. 작업 상태는 단일 writer 락과 체크포인트로 관리하며 같은 원인 실패가 3라운드를 넘기면 `BLOCKED_HUMAN_ATTENTION`으로 멈춥니다. 장기 결정과 이력은 Markdown 원문과 `node:sqlite` FTS5 색인(`memory.mjs`)으로 관리합니다.
3. **실행 검증과 증거 강도 (`verify.mjs`, `impact.mjs`):** `verify`는 보호된 기준선(`policy_base_ref`)에서 검증 규칙을 읽어 `fast`·`unit`·`e2e`·`property`·`differential` 수용 기준과 Diff 기반 신뢰성 규칙(`observe`/`enforce`)을 실행합니다. 다언어(JS/TS·Python·Go·Rust·Java/Kotlin·C#·C/C++·Ruby·PHP) 정적 영향도 분석과 커스텀 분석기(`--analyzer-cmd`)를 결합해 `--selective` 회귀 테스트를 고르고, 전역 설정 변경이나 매칭 0건일 때는 전체 테스트로 돌아갑니다. 통과한 검사가 실제로 변경 코드를 실행했는지와 테스트 약화(삭제·skip·단언 감소) 여부를 `evidence_strength`에 기록하며 `--mutation-probe`를 켜면 변경된 줄을 깨뜨려 통과한 테스트가 실제로 실패하는지도 확인합니다.
4. **검토 보고서 발행과 교열 (`review-package.mjs`):** `READY_FOR_HUMAN_REVIEW` 단계에 올릴 8개 섹션 보고서(`reports/review-package.md`)를 만들고, 증거 매니페스트와의 수용 기준 일치 여부·깨진 파일 링크·Kouetsu `1.1.0` 기반 3계층 교열을 점검합니다. 교열은 저장소에 포함된 Kouetsu 번들로 바로 실행되고 결과를 기록합니다. 교열 결과가 발행을 막는 것은 계약이 `editorial.require_kouetsu`를 `true`로 둘 때뿐이며 기본값은 `false`입니다. `[확인 필요]` 표시가 중요 절에 남아 있으면 어느 경우든 막습니다. `EDITORIAL_GATE_FAILED`나 `CRITICAL_CONFIRMATION_BLOCKED`로 차단되면 `.crafthelm/runs/<run_id>/reports/editorial-report.json`의 `findings`와 `critical_confirmations`를 확인해 문구 또는 미해결 항목을 정리한 뒤 `review-package`를 다시 실행합니다.
5. **사람의 최종 인수 (`approval.mjs`):** AI 에이전트 세션과 비대화형 터미널의 `approve record` 호출을 막고, 지정 승인자의 명시적 결정과 사유만 기록합니다. 저장소에 보호된 승인자 정책(`.crafthelm/approvers.json`)이 있으면 등록된 `actor`의 `ed25519` 서명만 받습니다. 서명을 강제하려면 AI 세션 밖의 터미널에서 `approve keygen --out <개인키_경로> --actor <이름>`으로 키를 만든 뒤 개인키는 저장소 밖에 보관하고, 출력된 공개키 지문을 기본 브랜치의 `.crafthelm/approvers.json`(`"require_signed": true`)에 커밋합니다. 인수 결정은 검증된 스냅샷에 대한 것입니다. 인수 뒤에 계약·증거·보고서·서명이 달라지면 효력을 무효로 판정하고, 코드가 더 바뀐 것은 무효로 보지 않고 결정 기록과 `approve verify` 결과에 알립니다.

## 판정 주체와 한계

| 판정 구분 | 담당 주체 | 확인하는 것과 한계 |
|---|---|---|
| 결정적 검증 | 로컬 검증 스크립트 | 계약·범위·스냅샷·테스트 종료 코드·링크 일치를 기계적으로 확인합니다. 테스트 자체의 품질이나 누락된 시나리오는 대신 판단하지 못합니다 |
| AI 보조 리뷰 | 분리된 리뷰어 컨텍스트 | 코드와 설계의 위험 가설을 제안합니다. 제안은 참고용이며 사실을 확정하지 않습니다 |
| 문서 교열 | Kouetsu (`1.1.0`) | 보고서 문장의 명확성·모순·누락·표면 패턴을 점검합니다. 코드 결함 부재나 사실 진위를 증명하지 않습니다 |
| 최종 인수 | 지정된 사람·승인자 | 검증 결과와 남은 위험을 검토해 승인·수정 요청·반려·추가 검증을 결정하고 책임을 집니다 |

요구 런타임은 Node.js 24 이상입니다. 낮은 버전에서 실행하면 CLI가 필요한 버전을 한 줄로 알리고 멈춥니다.

## 두 가지 승인

이름이 비슷하지만 묻는 것과 할 수 있는 주체가 다릅니다.

| | 계약 승인 | 최종 인수 |
|---|---|---|
| 묻는 것 | 이 범위와 수용 기준으로 작업을 시작해도 되는가 | 검증된 결과를 받아들이는가 |
| 시점 | 작업 전 | 검증과 검토 보고서 발행 뒤 |
| 명령 | `contract approve`, `start --approve-contract` | `review`(브라우저 검토 화면), `approve record`, `approve batch` |
| 에이전트 세션에서 | 사용자가 대화에서 동의하면 에이전트가 실행할 수 있습니다. Claude Code는 실행 전에 사용자에게 확인을 묻고, 기록에는 `agent_session` 경로로 남습니다 | 실행되지 않습니다. 사람이 자기 터미널에서 실행합니다 |
| 남는 기록 | 계약의 `approval`과 승인된 계약의 사본 | 실행별 `approvals/decision.json` |

프로젝트가 엄격 구역을 정하고 `zones set-light --mode standing`으로 규칙을 켜 두면, 수정 범위가 엄격 구역에 닿을 수 없는 계약은 `contract begin`으로 승인 확인 없이 시작합니다. 이 계약은 사람이 승인한 것으로 기록되지 않고 규칙으로 시작했다고 남습니다. 기본은 꺼져 있고, 최종 인수에는 영향이 없습니다.

계약 승인은 작업의 허가이고 결과의 수락이 아닙니다. 계약이 승인되어도 최종 인수는 `PENDING`으로 남습니다. 승인한 뒤 계약을 고치면 승인된 사본과 대조해 실행 시작과 재계획을 막습니다(`contract diff`로 차이 확인).

## 에이전트의 보고를 믿지 않는 지점

검사는 에이전트가 아니라 `verify` 스크립트가 실행하고 출력과 종료 코드를 실행 디렉터리에 남깁니다. 에이전트가 "통과했다"고 적은 문장은 근거로 쓰이지 않습니다.

| 우회 시도 | 막는 장치 | 결과 |
|---|---|---|
| 실행하지 않은 테스트를 통과했다고 보고 | `verify`가 계약의 명령을 직접 실행 | 종료 코드가 기대와 다르면 `AC_FAILED`로 실패합니다 |
| 계약에 없는 파일이나 보호 경로를 수정 | `scope.allow`·`scope.protect`와 diff 대조 | `SCOPE_VIOLATION` 또는 `PROTECTED_PATH_VIOLATION`으로 실패합니다 |
| 실행 디렉터리(`review.json`·`inbox/**` 제외)나 통제 파일을 직접 수정 | Claude Code 프로젝트 범위 설치 시 등록된 범위 가드 훅(실행이 없을 때도 동작) | `Edit`·`Write` 계열 도구 호출을 차단하고 `SCRIPT_OWNED_ARTIFACT` 또는 `CONTROL_FILE`을 돌려줍니다 |
| 검증 규칙이나 계약을 고쳐서 통과 | 정책은 `policy_base_ref`에서 읽고 계약은 해시로 고정 | 변조 시 `CONTRACT_HASH_MISMATCH`가 발생합니다 |
| 실패하는 테스트를 끄거나 지워서 통과 | 테스트 파일 diff 검사 (`test-weakening.mjs`) | 증거 강도를 `weak`로 낮추고 `TEST_FILE_DELETED`·`TEST_SKIP_ADDED`·`ASSERTIONS_REMOVED`를 올립니다 |
| 변경 코드를 건드리지 않는 테스트만 통과 | 영향도 분석과 `--mutation-probe` | 증거 강도를 낮추고 `NO_TEST_REACHES_CHANGE`·`MUTANTS_SURVIVED`를 보고합니다 |
| 검증 뒤에 코드나 저장된 증거 로그를 수정 | 스냅샷 해시와 `stdout_sha256`·`stderr_sha256` 재대조 | `STALE_SNAPSHOT`, `EVIDENCE_LOG_ALTERED`, `INVALIDATED`, `STALE_ARTIFACTS_CANNOT_RESTORE`로 막습니다 |
| 스스로 최종 인수를 승인 | 에이전트 세션·비대화형 터미널 차단 및 서명 정책 | 승인 레코드를 생성하지 않습니다 |

증거 로그 해시는 `verify`가 매니페스트에 기록한 뒤 `review-package`, `approve record`, `approve verify`, `checkpoint resume`에서 매번 다시 대조합니다. 로그는 저장하기 전에 시크릿 패턴과 관련 환경 변수 값을 가립니다. Claude Code 범위 가드 훅은 파일 도구 호출만 보므로, 다른 호스트나 셸 명령으로 쓴 파일은 `verify`가 사후에 차단합니다. 증거 강도 신호는 검증 자체를 실패시키지 않고 검토 보고서 위험 항목에 올립니다. 낡은 테스트를 지우는 정당한 변경과 구별하기 어렵기 때문에 최종 판단은 승인자에게 남깁니다. 단, 경량 프로필에서는 등급이 `weak`가 되면 E2E 면제를 취소합니다. 각 항목의 조건과 한계는 [품질 계약 문서](docs/quality-contract.md)에 있습니다.

## 빠른 시작

CraftHelm은 별도 패키지 설치 없이 이 저장소를 클론한 디렉터리에서 실행하며, `--repo`로 대상 저장소를 지정합니다. 대상 저장소에는 기준선 비교와 스냅샷 계산을 위해 초기 커밋이 있는 Git 저장소가 필요합니다.

아래 명령을 순서대로 실행하면 대상 저장소에서 인터뷰, 계약 승인, 실행 기준선 동결, 검증, 검토 보고서 발행, 사람 인수 결정까지 한 번에 확인합니다.

```bash
# 1) 대상 저장소 준비 및 작업 시작 (환경·러너 탐지 + CH-T001 계약 생성 + 다음 명령 안내)
node scripts/crafthelm.mjs init-host --repo /path/to/repo --host generic
node scripts/crafthelm.mjs start "로그인 토큰 만료 비교 연산 오류 수정" \
  --repo /path/to/repo \
  --change-kind bugfix \
  --scope-allow "src/**,tests/**" \
  --e2e-cmd "node tests/e2e.test.mjs"

# 2) 계약 스키마와 E2E 정책 확인 뒤 명시적 승인
node scripts/crafthelm.mjs contract validate /path/to/repo/.crafthelm/contracts/CH-T001.json
node scripts/crafthelm.mjs contract approve /path/to/repo/.crafthelm/contracts/CH-T001.json --actor operator

# 3) 실행 기준선 동결과 현재 상태 확인 (`--run-id`로 실행 ID 직접 지정)
node scripts/crafthelm.mjs checkpoint init \
  --repo /path/to/repo \
  --contract /path/to/repo/.crafthelm/contracts/CH-T001.json \
  --run-id RUN-001
node scripts/crafthelm.mjs status --repo /path/to/repo

# --- 여기서 범위(scope.allow) 안의 코드를 수정합니다 ---

# 4) 선택적 회귀 테스트 + E2E 검증 실행 (stderr: 로그, stdout: 결과 JSON)
node scripts/crafthelm.mjs verify --repo /path/to/repo --run-id RUN-001

# 5) 8개 섹션 검토 보고서 발행 (READY_FOR_HUMAN_REVIEW 도달)
node scripts/crafthelm.mjs review-package --repo /path/to/repo --run-id RUN-001

# 6) 사람이 보고서를 검토한 뒤 최종 인수 결정 기록
#    (사람이 자기 터미널에서 실행. 서명이 없으면 보고서 SHA-256 끝 8자 입력.
#     `review --repo /path/to/repo`로 브라우저 검토 화면에서 결정할 수도 있습니다)
node scripts/crafthelm.mjs approve record \
  --repo /path/to/repo \
  --run-id RUN-001 \
  --decision ACCEPTED \
  --actor human-reviewer \
  --rationale "원인 수정과 단위·E2E 검증 증빙 확인 완료"
```

### 작은 작업용 단축 흐름

`--init-run`은 계약 승인과 실행 기준선 동결을 `start` 한 번에 묶고, `feedback`은 검증과 검토 보고서 발행을 묶습니다. `--init-run`은 `--run-id`를 따로 받지 않고 `<task_id>-RUN-001`(예: `CH-T001-RUN-001`)을 자동 생성합니다. 생성된 실행 ID는 `start` 출력의 `실행 ID` 줄이나 `node scripts/crafthelm.mjs status --repo /path/to/repo`로 확인합니다. 사람이 직접 실행하는 단계는 계약 승인과 최종 인수 두 번입니다.

```bash
# 1) 인터뷰 + 계약 생성·승인 + 실행 기준선 동결
node scripts/crafthelm.mjs start "로그인 토큰 만료 비교 연산 오류 수정" \
  --repo /path/to/repo --change-kind bugfix \
  --e2e-cmd "node tests/e2e.test.mjs" \
  --approve-contract --actor operator --init-run

# --- 범위(scope.allow) 안의 코드를 수정합니다 ---

# 2) 검증 + 검토 보고서 발행 (READY_FOR_HUMAN_REVIEW)
node scripts/crafthelm.mjs feedback --repo /path/to/repo --run-id CH-T001-RUN-001

# 3) 사람이 자기 터미널에서 최종 인수 결정 기록 (또는 `review --repo /path/to/repo`)
node scripts/crafthelm.mjs approve record --repo /path/to/repo --run-id CH-T001-RUN-001 \
  --decision ACCEPTED --actor human-reviewer --rationale "검증 증빙 확인 완료"
```

작은 버그 수정에서 E2E 명령을 마련하기 어렵다면 `--profile lite`를 붙이고 `--e2e-cmd`를 빼는 대신 변경 코드를 직접 호출하는 테스트 명령을 `--test-cmd "<명령>"`으로 넘깁니다. 범용 테스트 명령 하나만으로는 면제받지 못하며 `--test-cmd`가 빠지면 `start`가 계약 승인 전에 멈추고 `contract add-test`로 보완하라고 알립니다. 변경이 소스 파일 3개와 추가 60줄 이내이고 전용 테스트가 변경 코드에 닿을 때만 E2E 요구를 면제합니다. 범위를 넘기면 `verify`가 `LITE_PROFILE_EXCEEDED`로 실패합니다. 이 기본 한도는 실측 데이터 없이 정한 초기값이므로 E2E를 둔 버그 수정 기록이 쌓이면 `node scripts/crafthelm.mjs calibrate lite --repo <path>`로 한도 안에서 E2E가 결함을 잡은 사례가 있는지 확인합니다.

계약을 먼저 검토하고 승인하려면 `--approve-contract`를 빼고 `start`를 실행한 뒤, 안내되는 `contract approve <계약> --actor <이름> --init-run` 명령을 실행하세요.

## 주요 명령

```bash
npm test
node scripts/crafthelm.mjs start "작업 설명" --repo <target-repo>
node scripts/crafthelm.mjs status --repo <target-repo>
node scripts/crafthelm.mjs status --repo <target-repo> --run-id <run-id> --explain
npm run doctor:antigravity
npm run doctor:generic
npm run doctor:claude
npm run doctor:codex
node scripts/crafthelm.mjs init-host --repo <target-repo> --host antigravity
node scripts/crafthelm.mjs install-skills --targets claude,codex,gemini
node scripts/crafthelm.mjs install-skills --status
npm run install:skills
node scripts/crafthelm.mjs impact --repo . --json
node scripts/crafthelm.mjs route --task-type classify --host antigravity --json
node scripts/crafthelm.mjs verify --repo <target-repo> --run-id <run-id>
node scripts/crafthelm.mjs verify --repo <target-repo> --run-id <run-id> --history
node scripts/crafthelm.mjs feedback --repo <target-repo> --run-id <run-id>
node scripts/crafthelm.mjs approve keygen --out ~/.crafthelm/approver.pem --actor release-owner
node scripts/crafthelm.mjs approve verify --repo <target-repo> --run-id <run-id>
node scripts/crafthelm.mjs memory decide --title "Rotate refresh tokens" --body "Single-use rotation"
node scripts/crafthelm.mjs memory search --query "refresh token"
node scripts/crafthelm.mjs skills list
node scripts/crafthelm.mjs --help
```

벤치마크 명령(`benchmark`·`benchmark live --i-accept-cost`)의 비교 기준과 실측 한계는 [벤치마킹 정책](docs/benchmarking.md)에 있습니다. 실측 전까지 토큰·비용 절감 수치는 약속하지 않으며, 측정하지 못한 값은 `"unknown"`으로 기록합니다.

## 스킬 등록과 Claude Code 보호 설정

`init-host --host`와 `doctor --host`는 `claude`, `codex`, `antigravity`, `gemini`, `generic`, 사용자 정의 CLI(`--host custom --cli "<명령>"`)를 지원합니다(`npm run doctor:*`는 `claude`, `codex`, `antigravity`, `generic` 네 단축 스크립트를 제공합니다).

`install-skills --targets`에는 `claude`, `codex`, `gemini`, `antigravity`, `agents`, `all`을 지정합니다. `all`(또는 `claude,codex,gemini`)을 전역(`--scope user`)으로 설치하면 Claude Code(`~/.claude/skills/crafthelm`), Codex(`~/.codex/skills/crafthelm`), Antigravity(`~/.gemini/config/skills/crafthelm`), Gemini CLI(`~/.gemini/skills/crafthelm`) 네 경로에 단일 공급자 격리 규칙을 지키는 스킬을 등록합니다. 프로젝트 범위(`--scope project`)에서는 `<repo>` 아래 `.claude`, `.codex`, `.gemini`, `.agents` 디렉터리에 등록합니다. `--with-kouetsu`를 붙이면 에이전트가 평소 문서 작성에서도 `kouetsu` 스킬을 부를 수 있도록 같은 스킬 폴더 옆에 `kouetsu`를 복사합니다.

```bash
# 3개 타깃(Claude·Codex·Gemini/Antigravity) 전역 등록 (미리보기: --dry-run, Kouetsu 동반 복사: --with-kouetsu)
node scripts/crafthelm.mjs install-skills --targets claude,codex,gemini --dry-run
npm run install:skills

# 등록 상태 점검 및 CraftHelm 관리 디렉터리만 안전 제거
npm run skills:status
node scripts/crafthelm.mjs install-skills --targets all --uninstall

# 특정 프로젝트(.claude / .codex / .gemini / .agents)에만 등록
node scripts/crafthelm.mjs install-skills --targets all --scope project --repo <target-repo>
```

Claude Code에 설치하면 승인 보호 규칙도 해당 범위의 `settings.json`(사용자 범위는 `~/.claude/settings.json`, 프로젝트 범위는 `<repo>/.claude/settings.json`)에 추가합니다. 최종 인수 기록과 키 생성 명령은 `deny`, 계약 승인과 단계 승인 명령은 `ask`로 등록합니다. 기존 규칙은 지우지 않고 추가만 하며 빼고 싶으면 `--skip-claude-permissions`를 붙입니다. `init-host --host claude`도 프로젝트 설정에 같은 규칙을 합칩니다.

프로젝트 범위로 설치하면(`init-host --host claude`, `install-skills --scope project`) 범위 가드 훅도 `<repo>/.claude/settings.json`의 `PreToolUse`에 등록합니다. 이 훅은 활성 실행이 없어도 실행 디렉터리 산출물(`evidence/review.json`, `inbox/**` 외 전체)과 통제 파일(`.crafthelm/contracts/**`, `.claude/settings.json`, `.claude/settings.local.json`, `.crafthelm/approvers.json`, `.crafthelm/config.json`, `.crafthelm/skills.lock.json`) 쓰기를 즉시 차단합니다. 활성 실행 중에는 `scope.allow` 밖이거나 `scope.protect` 안인 파일의 `Edit`·`Write`·`MultiEdit`·`NotebookEdit` 호출을 막고 사유를 에이전트에게 돌려줍니다. 이때 경로는 심볼릭 링크·대소문자·Windows 짧은 이름과 대체 데이터 스트림까지 파일시스템 기준으로 풀어 비교합니다. 셸 명령으로 쓰는 파일은 훅이 보지 못하므로 최종 판정은 여전히 `verify`가 합니다. 훅 등록을 건너뛰려면 `--skip-claude-hooks`를 붙이세요. 판정 표와 한계는 [보안 정책](docs/security-policy.md)에 있습니다. `doctor --host claude`는 권한 규칙이나 훅이 빠졌거나 설치된 스킬 사본이 현재 체크아웃과 다르면 경고와 복구 명령을 출력합니다.

같은 설치에서 세션 상태 훅도 `SessionStart`와 `UserPromptSubmit`에 등록합니다. 스킬 지시문은 스킬을 부른 순간에만 읽히므로, 이 훅이 프롬프트마다 활성 실행의 ID·상태·`scope.allow`·다음 명령을 에이전트에게 다시 알려 줍니다. 활성 실행이 없으면 세션을 시작할 때 한 번만 안내합니다. `--skip-claude-hooks`를 붙이면 두 훅을 모두 등록하지 않습니다.

명령의 인자가 기억나지 않으면 `node scripts/crafthelm.mjs help <command>`를 씁니다. 안내되는 다음 명령(`next_command`)은 대상 저장소에서 실행해도 되도록 CraftHelm 스크립트의 절대 경로로 출력합니다. 하위 명령은 기본 300초가 지나면 중단되고 종료 코드 124로 끝납니다. 작업 트리 해시가 5초를 넘기면 진행 상황을 stderr에 알립니다. 큰 파일이 많은 저장소에서는 `CRAFTHELM_CLI_TIMEOUT_MS`로 제한을 늘리거나 `0`으로 끕니다.

## 문서 안내

- [아키텍처](docs/architecture.md): 모듈 구성과 공통 계약 계층
- [품질 계약과 검증](docs/quality-contract.md): 15개 검증 불변식, 증거 강도, 뮤테이션 검사, 경량 프로필
- [보안과 범위 가드 정책](docs/security-policy.md): 권한 경계, Claude Code 범위 가드 훅 판정표, 외부 스킬 감사
- [사람 인수 및 책임 정책](docs/human-review-policy.md): 에이전트 세션 차단, `ed25519` 승인자 서명 정책, 무효화 규칙
- [워크플로 계약과 상태 머신](docs/workflow-contract.md): 단일 writer 락, 재개, 재계획, 상태 전이 규칙
- [인터뷰 정책](docs/interview-policy.md): 불확실성 분류, 결정적 질문 생성, 5개 영역 검토 기준
- [위임 및 모델 라우팅 정책](docs/delegation-policy.md): 4단계 티어 라우팅과 위임 실행 기록
- [교열 정책](docs/editorial-policy.md): Kouetsu 게이트 역할과 한계
- [방법론 조합 정책](docs/methodology.md): `lifecycle`·`specification`·`engineering`·`execution` 조합 규칙
- [벤치마킹 정책](docs/benchmarking.md): 실측 비교군과 측정 한계
- [서드파티 고지](NOTICE.md): Kouetsu MIT 라이선스와 배포 범위
