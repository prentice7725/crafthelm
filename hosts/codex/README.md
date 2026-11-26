# Codex Host Adapter

Codex-only 환경에서 CraftHelm을 실행하기 위한 네이티브 어댑터입니다.

- `codex --version`, `codex --help`, `codex exec --help`로 실제 지원 기능(`exec`, `review`, `agents`, `sandbox`, `--model`)을 탐지합니다.
- 교열에는 `hosts/codex/skills/kouetsu/`에 MIT 라이선스와 출처를 보존해 포장한 규칙 패키지를 사용합니다. 원본 Claude 플러그인과의 자동 호환은 가정하지 않습니다.
- `claude`나 다른 공급자 CLI는 호출하지 않습니다.
- 다중 에이전트나 다중 모델을 지원하지 않는 환경에서는 순차 모드로 내려서 실행하고, 이 제한을 성공으로 속여 기록하지 않습니다.
