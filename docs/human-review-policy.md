# Human Review & Accountability Policy

## 책임 분리

- **자동 검사 PASS ≠ 인간 인수 승인.**
- `READY_FOR_HUMAN_REVIEW`는 검토 패키지 생성·Kouetsu 교열·증거 해시 고정이 완료된 상태일 뿐 완료(`ACCEPTED`)가 아니다.
- `approvals/decision.json`은 오직 `scripts/approval.mjs record`를 통한 명시적 사용자 입력으로만 생성된다.
- `actor`는 사용자 입력 문자열이다. 신원을 얼마나 확인했는지는 `verification_type`에 등급으로 남긴다.

## 승인 게이트와 신원 등급

`approval.mjs record`는 다음 순서로 호출자를 확인한다.

1. AI 에이전트 세션에서 실행되면 `HUMAN_GATE_AGENT_SESSION`으로 거부한다. 두 가지로 판별한다.
   - 호스트가 심는 환경 변수(`CLAUDECODE`, `AI_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX` 등)와 `CRAFTHELM_AGENT_SESSION`.
   - 부모 프로세스 체인. 위로 올라가며 에이전트 CLI(`claude` 실행 파일이나 `@anthropic-ai/claude-code`, `codex`나 `@openai/codex`, `gemini`나 `@google/gemini-cli`, `agy`)가 있는지 본다. 프로세스 이름, 명령줄의 첫 인자, 그리고 `node` 같은 인터프리터 뒤의 스크립트 경로를 함께 보므로, npm 설치본(`node /usr/local/bin/claude`)과 공백이 든 Windows 경로도 잡는다. Claude 데스크톱 앱과 Antigravity IDE 자체는 에이전트로 보지 않으므로, 사람이 앱의 터미널 패널에서 직접 실행하면 통과한다. 같은 이유로 IDE 안의 에이전트가 IDE 프로세스에서 바로 명령을 띄우는 경우는 이 검사로 구별하지 못하고, 환경 변수(`ANTIGRAVITY_AGENT`)와 TTY 조건, 서명 승인자 정책에 맡긴다. Windows와 Linux에서는 프로세스 생성 시각을 비교해, 재사용된 PID가 가리키는 나중에 생긴 프로세스를 부모로 오인하지 않는다. 프로세스 목록을 읽지 못하면 이 검사는 건너뛴다. Windows에서는 PowerShell로 목록을 읽어 1~2초가 걸린다.
2. 대화형 터미널이 아니면 `HUMAN_GATE_NO_TTY`로 거부한다. `--sign-key`로 서명하는 경우에만 이 조건을 면제한다.
3. 서명이 없으면 검토 보고서 SHA-256의 마지막 8자를 직접 입력해야 기록한다.

| `verification_type` | 의미 |
|---|---|
| `local_explicit_input_not_identity_verified` | 스크립트 함수를 직접 호출한 기록. 아무것도 확인하지 않았다. |
| `local_tty_confirmed_not_identity_verified` | 에이전트 세션 밖의 대화형 터미널에서 확인 코드를 입력했다. 터미널 앞에 누군가 있었다는 뜻이며 신원 확인은 아니다. |
| `signed_ed25519` | ed25519 개인키로 결정 레코드에 서명했다. 신뢰 여부는 보호된 승인자 정책이 정한다. |

환경 변수를 지우거나 `script` 같은 도구로 가짜 터미널을 붙여도 부모 체인에는 에이전트 CLI가 남으므로 거부된다. 그래도 이 게이트는 실수와 관성적인 자기 승인을 막는 장치이고, 신원 보장은 아니다. 다음 경로는 막지 못한다.

- 에이전트 트리에서 떨어져 나간 프로세스(데몬, 예약 작업, 원격 셸)에서 실행하는 경우. 부모 체인에 에이전트가 보이지 않는다.
- `recordHumanDecision`을 직접 호출하거나 `approvals/decision.json`을 직접 쓰는 경우. 같은 권한으로 도는 코드는 등급 필드까지 꾸며 쓸 수 있다.

서명이 없는 결정은 이렇게 꾸밀 수 있다고 보아야 한다. 에이전트가 꾸밀 수 없는 보장이 필요하면 아래 승인자 정책을 쓰고, 개인키를 에이전트가 읽을 수 없는 곳에 둔다.

## 승인자 정책 (`.crafthelm/approvers.json`)

```json
{
  "require_signed": true,
  "approvers": [
    { "actor": "release-owner", "public_key_fingerprint": "<sha256 of SPKI DER>" }
  ]
}
```

- 이 파일은 작업 트리에서 읽지 않고 `policy_base_ref`(없으면 체크포인트의 `baseline_git_head`)에서 `git show`로 읽는다. 작업 중에 고쳐도 효력이 없다.
- `require_signed: true`이면 목록에 있는 `actor`와 키 조합의 서명만 받는다. 서명이 없으면 `SIGNATURE_REQUIRED`, 목록에 없으면 `APPROVER_NOT_TRUSTED`로 거부하며, 이 검사는 CLI가 아닌 `recordHumanDecision` 함수 안에 있어 직접 호출로도 우회되지 않는다.
- 키는 `approval.mjs keygen --out <경로> --actor <이름>`으로 만든다. 개인키는 저장소 밖, 에이전트가 읽을 수 없는 경로에 둔다. 에이전트가 개인키를 읽을 수 있으면 이 정책도 보장을 잃는다.
- `approval.mjs verify`는 `identity`를 `UNSIGNED`, `SIGNATURE_INVALID`, `SIGNATURE_VALID_UNTRUSTED_KEY`, `SIGNATURE_TRUSTED` 중 하나로 보고한다. 정책 파일이 없으면 서명이 유효해도 `SIGNATURE_TRUSTED`라고 하지 않는다.

## 계약 승인과 단계 승인

실행 계약 승인(`contract approve`, `interview --approve-contract`)은 실행 권한만 주므로 에이전트 세션에서도 막지 않는다. 대신 승인 경로를 `approval.contract_approved_via`(`programmatic`, `agent_session`, `interactive_terminal`, `non_interactive`)에 남기고 검토 보고서 1절에 표시한다. Claude Code 권한 예시(`hosts/claude/settings.example.json`)는 계약 승인과 단계 승인을 `ask`로, 최종 인수 기록과 키 생성을 `deny`로 둔다. 이 승인 관련 규칙은 `install-skills`(claude 대상)와 `init-host --host claude`가 실제 `settings.json`에 추가하고(`scripts/lib/claude-permissions.mjs`), `doctor --host claude`가 사용자·프로젝트·로컬 설정을 합쳐 빠진 규칙을 `CLAUDE_PERMISSION_GUARDS_MISSING`으로 경고한다. 예시의 나머지 규칙(`git push`, `rm -rf`, 허용 목록)은 사용자 설정에 쓰지 않는다. 이 규칙도 사용자가 설정 파일을 고치면 사라지므로 통제 수단이 아니라 실수 방지 장치다. 에이전트의 의도적 우회에 대한 통제는 서명 승인자 정책이다.

## 승인 무효화 규칙

승인 이후 `target_snapshot_digest`, `contract_sha256`, `evidence_manifest_sha256`, `report_sha256` 중 하나라도 달라지면 기존 승인 효력은 즉시 무효화되며(`INVALIDATED`) 재검토가 필요하다.
