# Claude Code Host Adapter

Claude-only 환경에서 CraftHelm을 실행하기 위한 네이티브 어댑터입니다.

- `claude --version`과 `claude --help`로 실제 지원 기능(`--agents`, `--output-format`, `--model`, `--permission-mode`)을 탐지합니다.
- `~/.claude/plugins/`의 `kouetsu@1.1.0`를 읽기 전용으로 검증합니다.
- `codex`나 다른 공급자 CLI는 호출하지 않습니다.
- `settings.example.json`의 권한 규칙은 에이전트의 최종 인수 기록(`approve record`)과 승인자 키 생성(`approve keygen`)을 `deny`로 막고, 계약 승인과 Waterfall 단계 승인은 `ask`로 사용자 확인을 받습니다. 이 승인 관련 규칙은 `install-skills --targets claude`와 `init-host --host claude`가 실제 `settings.json`에 추가하며(`--skip-claude-permissions`로 생략), `doctor --host claude`가 빠진 규칙과 오래된 스킬 사본을 경고합니다.
- 범위 가드 훅(`scripts/hooks/scope-guard.mjs`)은 `Edit`·`Write`·`MultiEdit`·`NotebookEdit` 호출 전에 실행됩니다. 실행이 없을 때도 실행 디렉터리의 스크립트 소유 산출물(`evidence/review.json`, `inbox/**` 외 전체)과 통제 파일(`.crafthelm/contracts/**`, `.claude/settings.json`, `.claude/settings.local.json`, `.crafthelm/approvers.json`, `.crafthelm/config.json`, `.crafthelm/skills.lock.json`) 쓰기를 차단합니다. 실행 중에는 `scope.allow` 밖이거나 `scope.protect` 안인 파일 쓰기를 막습니다. `init-host --host claude`와 `install-skills --targets claude --scope project`가 프로젝트의 `.claude/settings.json`에 `PreToolUse` 훅으로 등록하며(`--skip-claude-hooks`로 생략), `doctor --host claude --repo <repo>`가 빠졌거나 다른 경로를 가리키는 등록을 경고합니다. 조건과 한계는 [보안 정책 문서](../../docs/security-policy.md)에 있습니다.
- 세션 상태 훅(`scripts/hooks/session-status.mjs`)은 `SessionStart`와 `UserPromptSubmit`에서 실행되어, 활성 실행의 ID·상태·`scope.allow`·다음 명령을 에이전트의 컨텍스트에 넣습니다. 스킬 지시문은 부른 순간에만 읽히기 때문에 그 뒤 턴에서도 절차가 보이게 하려는 것입니다. 범위 가드와 함께 등록되고 함께 생략됩니다.
- 단일 모델만 사용 가능할 때는 순차 독립 컨텍스트 모드로 내려서 실행하고 `independent_cross_model_review: "UNVERIFIED"`를 기록합니다.
