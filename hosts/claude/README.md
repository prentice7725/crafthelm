# Claude Code Host Adapter

Claude-only 환경에서 CraftHelm을 실행하기 위한 네이티브 어댑터입니다.

- `claude --version` 및 `claude --help`로 실제 기능(`--agents`, `--output-format`, `--model`, `--permission-mode`)을 탐지합니다.
- `~/.claude/plugins/`의 `kouetsu@1.0.2`를 읽기 전용으로 검증합니다.
- `codex` 또는 다른 공급자 CLI를 절대 호출하지 않습니다.
- 단일 모델 제한 시 순차 독립 컨텍스트로 강등하고 `independent_cross_model_review: "UNVERIFIED"`를 명시합니다.
