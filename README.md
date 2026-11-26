# CraftHelm

> **The Lead Steers. Workers Build. Evidence Decides.**  
> Single-Provider · Interview-First · Methodology-Composable · Delegation-First · Evidence-Driven

CraftHelm은 **단일 AI 공급자·단일 AI 호스트(Claude Code, Codex, Antigravity `agy`·IDE 세션, 또는 임의의 사용자 정의 AI CLI/에이전트)**로 동작하는 개발 운영 프레임워크입니다. 요구사항 인터뷰부터 실행 계약, 작업 분해, 구현, 실행 기반 검증, Kouetsu 교열 기반 인수 검토 보고서 발행, 그리고 **사람의 최종 인수 결정**까지의 흐름을 강제합니다.

## 핵심 원칙

- **Single Provider, Host-Agnostic:** Claude-only, Codex-only, Antigravity(`agy` 또는 IDE 세션), 또는 범용(`generic` / 사용자 정의 CLI) 환경에서 다른 공급자 CLI나 브로커 없이 완결됩니다.
- **Interview Before Execution:** `BLOCKER` 불확실성이 남으면 실행을 진행하지 않고 `INTERVIEW_REQUIRED`를 반환합니다.
- **Methodology Composable:** `lifecycle × specification × engineering × execution` 4축으로 방법론을 조합합니다.
- **Verification Is Executed Evidence:** 결정적 스크립트가 보호된 `base_ref` 기준선의 정책을 사용해 실제 명령을 실행하고 스냅샷 해시를 연결합니다.
- **Human Owns Done:** 자동 검증 통과 상태는 `READY_FOR_HUMAN_REVIEW`까지만 도달합니다. `COMPLETE` 상태는 존재하지 않으며, `ACCEPTED` 전이는 오직 지정 승인자의 명시적 결정 입력으로만 가능합니다.

## 책임 경계

| 판정 유형 | 주체 | 의미 |
|---|---|---|
| Deterministic Check | 로컬 검증 스크립트 | 계약·범위·스냅샷·테스트·링크 일치 여부를 기계적으로 확인 |
| AI Advisory Review | 분리된 Reviewer 컨텍스트 | 코드·설계 위험 가설을 제시(사실 확정이 아님) |
| Editorial Review | Kouetsu | 문장 명확성·모순·누락·표면 패턴을 점검(코드/사실 검증이 아님) |
| Human Acceptance | 지정 사람/승인자 | 최종 인수 승인·수정 요청·반려·추가 검증을 결정하고 책임을 짐 |

## 현재 구현 범위

`main` 기준으로 동작하는 기능입니다.

- 13개 JSON Schema 계약 (`contracts/schemas/*.schema.json`)
- Claude / Codex / Antigravity(`agy`·IDE 세션) / Gemini / Generic·커스텀 CLI 단일 공급자 호스트 어댑터 및 `doctor` 환경 탐지
- 인터뷰·실행 계약·4축 방법론 플래너·단일 writer 락·체크포인트·재개/핸드오프 패킷(`tried_and_failed`)·재계획·3라운드 에스컬레이션
- Markdown SOT + 재구축 가능한 `node:sqlite` FTS5 장기 메모리(`memory.mjs`: `supersedes` 결정 교체·에피소드 로그 자연 감쇠, LLM 비용 0원)
- 다언어(JS/TS·Python·Go·Rust·Java/Kotlin·C#·C/C++·Ruby·PHP) 내장 + 커스텀 분석기 플러그인(`--analyzer-cmd`) 기반 AST·콜 그래프 영향도 분석(`impact.mjs`), 범용 테스트 러너 감지(`node-test`/`vitest`/`jest`/`pytest`/`go-test`/`cargo-test`/`maven`/`gradle`/`dotnet-test`/`rspec`/`phpunit`/`ctest`), 선택적 회귀 테스트(`verify.mjs --selective` + 안전 폴백), 자동 검증·피드백·승인 요청 루프(`feedback-loop.mjs`)
- 4티어 비용 효율 모델 분리 라우터(`route.mjs`: `deterministic` / `lightweight` / `standard` / `reasoning`, `host_profiles`·`CRAFTHELM_MODEL_*`·다국어 프롬프트 분류·커스텀 CLI/인세션 `supports_multi_model` 지원)
- 보호된 `policy_base_ref` 기반 실행 검증(`fast`/`unit`/`e2e`/`property`/`differential`), Diff-Triggered Reliability Rules(`observe`/`enforce`), 스냅샷 `STALE` 탐지
- Kouetsu 1.0.2 감사·Pinning 및 Review Package 교열·링크/AC 교차 검증 게이트
- 명시적 인간 결정 레코드(`approval.mjs`) 및 코드/보고서 변경 시 승인 효력 무효화 검증
- 뮤테이션 검사(`verify --mutation-probe`): 변경된 줄을 깨뜨려 통과한 검사가 실패하는지 확인하는 결정적 교차 검증 대체 수단. 검사 도중 중단되면 다음 `verify`가 저널을 검증해 원본을 복원하고, 그사이 파일이 바뀌었으면 복원하지 않고 `probe_recovery`에 기록
- 실측 벤치마크(`benchmark live --i-accept-cost`): 호스트 CLI가 보고한 토큰·비용으로 A/B/C 비교
- 위임 실행 기록(`delegate run|record`): 어댑터로 워커를 실제 실행해 사용량을 실측하거나 세션 내 워커 결과 패킷을 접수, 기록이 없으면 `UNOBSERVED` 표기
- 결정적 인터뷰 질문 생성(`interview_questions.md`)과 영역별 검토 여부(`uncertainty_coverage`), 엄격 모드(`--strict-interview`)
- 증거 강도 등급(`evidence_strength`): 통과한 검사가 이번 변경을 실제로 다루는지 기계적으로 판정해 검토 보고서에 표시
- 작은 작업용 단축 흐름: `start --init-run`(계약 승인 + 기준선 동결), `feedback`(검증 + 보고서 발행)
- 경량 프로필(`--profile lite`): 작은 버그 수정에 한한 E2E 조건부 면제, 조건 초과 시 `LITE_PROFILE_EXCEEDED`. 변경 코드를 직접 호출하는 전용 테스트(`--test-cmd`, `contract add-test`)가 있어야 면제되며, `calibrate lite`로 한도를 실측 데이터와 대조
- 승인 게이트: 에이전트 세션·비대화형 실행 차단, 신원 등급 표기, 보호된 승인자 정책(`.crafthelm/approvers.json`) 기반 ed25519 서명 승인
- E01~E04, E10 결정적 벤치마크 하네스와 실측 A/B/C 하네스 (미측정 항목은 `"unknown"`으로 기록)
- GitHub Actions CI: 모든 PR과 `main` 푸시에서 Ubuntu·Windows, Node 24로 `npm test` 실행

## 빠른 시작 (작은 버그 수정 예제)

아래 순서를 그대로 복사해 실행하면 대상 저장소에서 인터뷰 → 계약 검증/승인 → 실행 체크포인트 생성 → E2E 포함 검증 → 검토 보고서 생성 → 사람의 최종 승인 기록까지 한 번에 확인할 수 있습니다.

```bash
# 1) 대상 저장소 준비 및 작업 시작 (환경/러너 자동 탐지 + CH-T001 계약 생성 + 다음 명령 안내)
node scripts/crafthelm.mjs init-host --repo /path/to/repo --host generic
node scripts/crafthelm.mjs start "로그인 토큰 만료 비교 연산 오류 수정" \
  --repo /path/to/repo \
  --change-kind bugfix \
  --e2e-cmd "node tests/e2e.test.mjs"

# 2) 계약 스키마 + E2E 정책 준비 상태 확인 후 명시적 승인
node scripts/crafthelm.mjs contract validate /path/to/repo/.crafthelm/contracts/CH-T001.json
node scripts/crafthelm.mjs contract approve /path/to/repo/.crafthelm/contracts/CH-T001.json --actor operator

# 3) 실행 기준선(체크포인트) 동결 및 현재 상태/다음 행동 확인
node scripts/crafthelm.mjs checkpoint init \
  --repo /path/to/repo \
  --contract /path/to/repo/.crafthelm/contracts/CH-T001.json \
  --run-id RUN-001
node scripts/crafthelm.mjs status --repo /path/to/repo

# --- 여기서 범위(scope.allow) 내 코드를 수정한 뒤 ---

# 4) 선택적 회귀 테스트 + E2E 검증 실행 (진행 로그는 stderr, 결과 JSON은 stdout)
node scripts/crafthelm.mjs verify --repo /path/to/repo --run-id RUN-001 --selective

# 5) 8개 섹션 검토 보고서 발행 (READY_FOR_HUMAN_REVIEW 도달)
node scripts/crafthelm.mjs review-package --repo /path/to/repo --run-id RUN-001

# 6) 사람이 보고서를 검토한 뒤 최종 인수 결정 기록
#    (AI 세션 밖의 대화형 터미널에서 직접 실행. 보고서 SHA-256 끝 8자 입력으로 확인)
node scripts/crafthelm.mjs approve record \
  --repo /path/to/repo \
  --run-id RUN-001 \
  --decision ACCEPTED \
  --actor human-reviewer \
  --rationale "원인 수정과 단위·E2E 검증 증빙 확인 완료"
```

### 작은 작업용 단축 흐름

`--init-run`은 계약 승인과 실행 기준선 동결을 `start` 한 번에 묶고, `feedback`은 검증과 검토 보고서 발행을 묶습니다. 사람이 하는 일은 계약 승인 확인과 최종 인수 두 번입니다.

```bash
# 1) 인터뷰 + 계약 생성·승인 + 실행 기준선 동결
node scripts/crafthelm.mjs start "로그인 토큰 만료 비교 연산 오류 수정" \
  --repo /path/to/repo --change-kind bugfix \
  --e2e-cmd "node tests/e2e.test.mjs" \
  --approve-contract --actor operator --init-run

# --- 범위(scope.allow) 내 코드 수정 ---

# 2) 검증 + 검토 보고서 발행 (READY_FOR_HUMAN_REVIEW)
node scripts/crafthelm.mjs feedback --repo /path/to/repo --run-id CH-T001-RUN-001 --selective

# 3) 사람이 AI 세션 밖의 터미널에서 최종 인수 결정 기록
node scripts/crafthelm.mjs approve record --repo /path/to/repo --run-id CH-T001-RUN-001 \
  --decision ACCEPTED --actor human-reviewer --rationale "검증 증빙 확인 완료"
```

작은 버그 수정이고 E2E 명령을 마련하기 어렵다면 `--profile lite`를 붙이고 `--e2e-cmd`를 빼는 대신, 변경한 코드를 직접 호출하는 테스트의 실행 명령을 `--test-cmd "<명령>"`으로 넘깁니다. 범용 테스트 명령 하나만으로는 면제를 받을 수 없어서, `--test-cmd`가 없으면 `start`가 계약 승인 전에 멈추고 `contract add-test`로 보완하라고 안내합니다. 변경이 소스 3개 파일·60줄 이내이고 이 전용 테스트가 변경 코드에 닿을 때만 E2E 요구가 면제되며, 조건을 벗어나면 `verify`가 `LITE_PROFILE_EXCEEDED`로 실패합니다. 이 한도는 아직 데이터 없이 정한 초기값입니다. E2E를 둔 버그 수정 실행이 쌓이면 `node scripts/crafthelm.mjs calibrate lite --repo <path>`로 한도 안에서 E2E가 실제로 결함을 잡은 적이 있는지 확인할 수 있습니다.

계약을 먼저 검토하고 싶으면 `--approve-contract`를 빼고 실행한 뒤 안내되는 `contract approve <계약> --actor <이름> --init-run` 명령을 씁니다.

## 주요 명령

```bash
npm test
node scripts/crafthelm.mjs start "작업 설명" --repo <target-repo>
node scripts/crafthelm.mjs status --repo <target-repo>
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
node scripts/crafthelm.mjs verify --repo <target-repo> --run-id <run-id> --selective
node scripts/crafthelm.mjs feedback --repo <target-repo> --run-id <run-id> --selective
node scripts/crafthelm.mjs memory decide --title "Rotate refresh tokens" --body "Single-use rotation"
node scripts/crafthelm.mjs memory search --query "refresh token"
node scripts/crafthelm.mjs --help
node scripts/skills.mjs list
```

## Claude Code·Codex·Gemini 스킬 등록

CraftHelm은 Claude Code(`.claude-plugin/plugin.json` 또는 `~/.claude/skills/crafthelm`), Codex(`~/.codex/skills/crafthelm`), Gemini CLI / Antigravity(`gemini-extension.json`, `~/.gemini/skills/crafthelm`, `~/.gemini/config/skills/crafthelm`)에서 각각 단일 공급자 격리 규칙을 지키는 스킬로 등록할 수 있습니다.

```bash
# 3개 호스트 전역 일괄 등록 (미리보기: --dry-run, Kouetsu 동반 설치: --with-kouetsu)
node scripts/crafthelm.mjs install-skills --targets claude,codex,gemini --dry-run
npm run install:skills

# 등록 상태 점검 및 안전 제거 (CraftHelm 관리 디렉터리만 제거)
npm run skills:status
node scripts/crafthelm.mjs install-skills --targets all --uninstall

# 특정 프로젝트(.claude / .codex / .gemini / .agents)에만 등록
node scripts/crafthelm.mjs install-skills --targets all --scope project --repo <target-repo>
```

Claude Code에 설치하면 승인 보호 규칙도 그 범위의 `settings.json`(사용자 범위는 `~/.claude/settings.json`, 프로젝트 범위는 `<repo>/.claude/settings.json`)에 추가합니다. 최종 인수 기록·키 생성 명령은 `deny`, 계약·단계 승인 명령은 `ask`입니다. 규칙은 추가만 하고 기존 규칙은 지우지 않으며, 원하지 않으면 `--skip-claude-permissions`를 붙입니다. `init-host --host claude`도 프로젝트 설정에 같은 규칙을 합칩니다. `doctor --host claude`는 규칙이 빠졌거나 설치된 스킬 사본이 현재 체크아웃과 다르면 경고와 다시 실행할 명령을 출력합니다.

> 주의: 벤치마크 토큰/비용 절감 수치는 실측 전까지 약속하지 않으며, 미측정 항목은 `unknown`으로 출력합니다.
