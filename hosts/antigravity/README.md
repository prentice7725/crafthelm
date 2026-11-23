# Antigravity Host Adapter

Antigravity (`agy` CLI 또는 Antigravity IDE/채팅 세션)에서 CraftHelm을 실행하기 위한 네이티브 어댑터입니다.

- `agy --version`, `agy --help`로 실제 지원 플래그(`-p`/`--print`, `--output-format`, `--model`, `--agent`, `--effort`, `--mode`, `--sandbox`, `--json-schema`)를 탐지합니다.
- `agy` CLI가 없는 세션 환경(`--in-session` 또는 `CRAFTHELM_IN_SESSION=1`)에서는 `host_native_session` 모드로 동작하며 제한 사유를 명시합니다.
- 교열에는 `.agents/skills/kouetsu/` 또는 `hosts/universal/skills/kouetsu/`의 MIT 출처 보존 규칙 패키지를 사용합니다.
- `claude` 또는 `codex` CLI를 절대 호출하지 않습니다.
