# Claude Code Host Adapter

Claude-only 환경에서 CraftHelm을 실행하기 위한 네이티브 어댑터입니다.

- `claude --version` 및 `claude --help`로 실제 기능(`--agents`, `--output-format`, `--model`, `--permission-mode`)을 탐지합니다.
- `~/.claude/plugins/`의 `kouetsu@1.0.2`를 읽기 전용으로 검증합니다.
- `codex` 또는 다른 공급자 CLI를 절대 호출하지 않습니다.
- `settings.example.json`의 권한 규칙은 에이전트의 최종 인수 기록(`approve record`)과 승인자 키 생성(`approve keygen`)을 `deny`로 막고, 계약 승인과 Waterfall 단계 승인은 `ask`로 사용자 확인을 받습니다. 이 승인 관련 규칙은 `install-skills --targets claude`와 `init-host --host claude`가 실제 `settings.json`에 추가하고(`--skip-claude-permissions`로 생략), `doctor --host claude`가 빠진 규칙과 오래된 스킬 사본을 경고합니다.
- 단일 모델 제한 시 순차 독립 컨텍스트로 강등하고 `independent_cross_model_review: "UNVERIFIED"`를 명시합니다.
